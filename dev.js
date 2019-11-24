"use strict";

const CONF = require("/boot/robot.json"); // Configuration locale

const TRAME = require("./trame.js");

const PORTROBOTS = 86;     // Numéro de back-end, ne pas modifier
const PORTTCPVIDEO = 8003; // Ports locaux de laison inter processus
const PORTTCPAUDIO = 8004;

const FICHIERLOG = "/var/log/vigiclient.log";

const PROCESSDIFFUSION = "/usr/local/vigiclient/processdiffusion";
const PROCESSDIFFAUDIO = "/usr/local/vigiclient/processdiffaudio";

// Chemin processus vidéo par défaut qui peut être surchargé dans la configuration locale
const CMDDIFFUSION = [
    PROCESSDIFFUSION,
    " SOURCEVIDEO",
    " | /bin/nc 127.0.0.1 PORTTCPVIDEO",
    " -w 2"
];

// Chemin processus audio par défaut qui peut être surchargé dans la configuration locale
const CMDDIFFAUDIO = [
    PROCESSDIFFAUDIO,
    " -loglevel fatal",
    " -f alsa",
    " -ac 1",
    " -i hw:1,0",
    " -ar 16000",
    " -c:a pcm_s16le",
    " -f s16le",
    " tcp://127.0.0.1:PORTTCPAUDIO"
];

const FRAME0 = "$".charCodeAt();    // Premier octet de synchronisation toujours $
const FRAME1S = "S".charCodeAt();   // Second octet de synchronisation pour une trame binaire en provenance du serveur et à destination du robot
const FRAME1T = "T".charCodeAt();   // Second octet de synchronisation pour une trame comportant un fragment de message texte du chat (TTS)
const FRAME1R = "R".charCodeAt();   // Second octet de synchronisation pour une trame binaire en provenance du robot et à destination du serveur

const V4L2 = "/usr/bin/v4l2-ctl";
const LATENCEFINALARME = 250;       // Repasse en débit vidéo configuré si la latence retombe sous cette valeur (fonction hystérésis min)
const LATENCEDEBUTALARME = 500;     // Surcharge le débit vidéo configuré si la latence passe au dela de cette valeur (fonction hystérésis max)
const BITRATEVIDEOFAIBLE = 100000;  // Débit vidéo réduit (surcharge le débit configuré afin d'éviter une saturation du canal TCP montant)
const TXRATE = 50;                  // Fréquence nominale des trames, utilisé dans le calcul prédictif de la latence ne pas modifier

const BOOSTVIDEOLUMINOSITE = 80;    // Surcharge la configuration vidéo avec une luminosité max à la demande de l'utilisateur (overlay de commande GPIO)
const BOOSTVIDEOCONTRASTE = 100;    // Surcharge la configuration vidéo avec un contraste max à la demande de l'utilisateur (overlay de commande GPIO)

const SEPARATEURNALU = new Buffer.from([0, 0, 0, 1]);

const CW2015ADDRESS = 0x62;
const CW2015WAKEUP = new Buffer.from([0x0a, 0x00]);
const MAX17043ADDRESS = 0x10;
const BQ27441ADDRESS = 0x55;


const OS = require("os");
const FS = require("fs");
const IO = require("socket.io-client");
const EXEC = require("child_process").exec;
const RL = require("readline");
const NET = require("net");
const SPLIT = require("stream-split");
const SP = require("serialport");
const I2C = require("i2c-bus");

const VERSION = Math.trunc(FS.statSync(__filename).mtimeMs);
const PROCESSTIME = Date.now();
const OSTIME = PROCESSTIME - OS.uptime() * 1000;

let sockets = {};
let serveurCourant = "";

let up = false;         // Passe à true si le robot sort de veille
let init = false;       // Mutex qui bloque certaines fonctions quand le robot n'a pas reçu sa conf
let initVideo = false;  // Mutex qui bloque certaines fonctions quand le sous système de capture vidéo n'est pas initialisée
let conf;               // Globale de configuration type télécommande du robot
let hard;               // Globale de configuration type hardware du robot
let tx;                 // Singleton avec les assesseurs pour lire les valeurs de la télécommande
let rx;                 // Singleton avec les assesseurs pour écrire les valeurs de télémétrie
let oldCamera;          // Utilisé pour exécuter du code uniquement en cas de changement de caméra dans la trame
let confVideo;          // Comporte la configuration vidéo de la caméra courante
let cmdDiffusion;       // Comporte la commande de diffusion vidéo (dyamiquement adaptée sur les gros robots avec ffmpeg et sans V4L2)
let cmdDiffAudio;       // Comporte la commande de diffusion audio

let lastTimestamp = Date.now();
let latence = 0;
let lastTrame = Date.now();
let alarmeLatence = false;

let oldOutils = [];     // Utilisé pour exécuter du code uniquement en cas de changement
let oldMoteurs = [];    // Utilisé pour exécuter du code uniquement en cas de changement
let rattrapage = [];    // Rattrapage de jeu automatique pour les consignes en position (anti hystétésis prédictif)

let boostVideo = false;
let oldBoostVideo = false;

let serial;

let i2c;
let gaugeType;
let gaugeBuffer = new Buffer.alloc(256);

let pca9685Driver = [];

if (typeof CONF.CMDDIFFUSION === "undefined")
    CONF.CMDDIFFUSION = CMDDIFFUSION;

if (typeof CONF.CMDDIFFAUDIO === "undefined")
    CONF.CMDDIFFAUDIO = CMDDIFFAUDIO;

CONF.SERVEURS.forEach(function (serveur) {
    // will connect for each server
    sockets[serveur] = IO.connect(serveur, { "connect timeout": 1000, transports: ["websocket"], path: "/" + PORTROBOTS + "/socket.io" });
});

trace("Démarrage du client");

i2c = I2C.openSync(1);

// Try for each kind of boards

try { // C'est du plug and play !
    i2c.i2cWriteSync(CW2015ADDRESS, 2, CW2015WAKEUP);
    gaugeType = "cw2015";
} catch (err) {
    try {
        i2c.i2cReadSync(MAX17043ADDRESS, 6, gaugeBuffer);
        gaugeType = "max17043";
    } catch (err) {
        try {
            i2c.i2cReadSync(BQ27441ADDRESS, 29, gaugeBuffer);
            gaugeType = "bq27441";
        } catch (err) {
            trace("No I2C fuel gauge detected");
            i2c.closeSync();
            gaugeType = "";
        }
    }
}

function map(n, inMin, inMax, outMin, outMax) {
    return Math.trunc((n - inMin) * (outMax - outMin) / (inMax - inMin) + outMin);
}

function trace(message) {
    console.log(message)
}

function traces(id, messages) {
    let tableau = messages.split("\n");
    if (!tableau[tableau.length - 1])
        tableau.pop();
    for (let i = 0; i < tableau.length; i++)
        trace(id + " | " + tableau[i]);
}

function sigterm(nom, processus, callback) {
    trace("Envoi du signal SIGTERM au processus " + nom);
    let processkill = EXEC("/usr/bin/pkill -15 -f ^" + processus);
    processkill.on("close", function (code) {
        callback(code);
    });
}

function exec(nom, commande, callback) {
    trace("Démarrage du processus " + nom);
    trace(commande);
    let processus = EXEC(commande);
    let stdout = RL.createInterface(processus.stdout);
    let stderr = RL.createInterface(processus.stderr);
    let pid = processus.pid;
    let execTime = Date.now();

    //processus.stdout.on("data", function(data) {
    stdout.on("line", function (data) {
        traces(nom + " | " + pid + " | stdout", data);
    });

    //processus.stderr.on("data", function(data) {
    stderr.on("line", function (data) {
        traces(nom + " | " + pid + " | stderr", data);
    });

    processus.on("close", function (code) {
        let elapsed = Date.now() - execTime;

        trace("Le processus " + nom + " c'est arrêté après " + elapsed + " millisecondes avec le code de sortie " + code);
        callback(code);
    });
}

function debout() {

    if (hard.CAPTURESENVEILLE) {
        sigterm("Raspistill", "raspistill", function (code) {
            diffusion();
        });
    } else
        diffusion();
    diffAudio();

    up = true;
    lastTimestamp = Date.now();
    latence = 0;
}

function dodo() {
    serveurCourant = "";

    sigterm("Diffusion", PROCESSDIFFUSION, function (code) {
    });

    sigterm("DiffAudio", PROCESSDIFFAUDIO, function (code) {
    });

    up = false;
}

function configurationVideo(callback) {
    cmdDiffusion = CONF.CMDDIFFUSION.join("").replace("SOURCEVIDEO", confVideo.SOURCE
    ).replace("PORTTCPVIDEO", PORTTCPVIDEO
    ).replace("ROTATIONVIDEO", confVideo.ROTATION
    ).replace(new RegExp("BITRATEVIDEO", "g"), confVideo.BITRATE);
    cmdDiffAudio = CONF.CMDDIFFAUDIO.join("").replace("PORTTCPAUDIO", PORTTCPAUDIO);

    trace("Initialisation de la configuration Video4Linux");

    exec("v4l2-ctl", V4L2 + " -v width=" + confVideo.WIDTH +
        ",height=" + confVideo.HEIGHT +
        ",pixelformat=4" +
        " -p " + confVideo.FPS +
        " -c h264_profile=0" +
        ",repeat_sequence_header=1" +
        ",rotate=" + confVideo.ROTATION +
        ",video_bitrate=" + confVideo.BITRATE +
        ",brightness=" + confVideo.LUMINOSITE +
        ",contrast=" + confVideo.CONTRASTE, function (code) {
            console.log('DLLKDSQLQDSLDSLSDLQDLSL EXITED')
            callback(code);
        });
}

function diffusion() {
    trace("Démarrage du flux de diffusion vidéo H.264");
    exec("Diffusion", cmdDiffusion, function (code) {
        trace("Arrêt du flux de diffusion vidéo H.264");
    });
}

function diffAudio() {
    trace("Démarrage du flux de diffusion audio");
    exec("DiffAudio", cmdDiffAudio, function (code) {
        trace("Arrêt du flux de diffusion audio");
    });
}

CONF.SERVEURS.forEach(function (serveur, index) {

    sockets[serveur].on("connect", function () { // Authentification du robot, si invalide le serveur le laisse dans un sas d'attente et demande un reboot après une minute
        trace("Connecté sur " + serveur + "/" + PORTROBOTS);
        //send wifi config
        EXEC("hostname -I").stdout.on("data", function (ipPriv) {
            EXEC("iwgetid -r || echo $?").stdout.on("data", function (ssid) {
                sockets[serveur].emit("serveurrobotlogin", {
                    conf: CONF,
                    version: VERSION,
                    processTime: PROCESSTIME,
                    osTime: OSTIME,
                    ipPriv: ipPriv.trim(),
                    ssid: ssid.trim()
                });
            });
        });
    });

    // CONFIGURATION INITIALISATION
    if (index == 0) { // Ne prendre en compte que la configuration du premier serveur configuré (de toutes façons seuls les devs ont plusieurs serveurs)
        sockets[serveur].on("clientsrobotconf", function (data) {
            trace("Réception des données de configuration du robot depuis le serveur " + serveur);

            conf = data.conf; // Récupérer la conf
            hard = data.hard;

            tx = new TRAME.Tx(conf.TX); // Récupérer le format de trame et instancier l'objet avec les assesseurs
            rx = new TRAME.Rx(conf.TX, conf.RX);


            oldCamera = conf.COMMANDES[conf.DEFAUTCOMMANDE].CAMERA;
            confVideo = hard.CAMERAS[oldCamera];
            boostVideo = false;
            oldBoostVideo = false;

            setTimeout(function () {
                configurationVideo(function (code) {
                    initVideo = true;
                });
            }, 100);

            if (!init) {
                serial = new SP(hard.DEVROBOT, {
                    baudRate: hard.DEVDEBIT,
                    lock: false
                });

                serial.on("open", function () {
                    trace("Connecté sur " + hard.DEVROBOT);

                    serial.on("data", function (data) {
                        if (hard.DEVTELEMETRIE) {
                            CONF.SERVEURS.forEach(function (serveur) {
                                if (serveurCourant && serveur != serveurCourant)
                                    return;

                                sockets[serveur].emit("serveurrobotrx", {
                                    timestamp: Date.now(),
                                    data: data
                                });
                            });
                        }
                    });

                    init = true;
                });
            }
        });
    }

    // On disconnect
    sockets[serveur].on("disconnect", function () {
        trace("Déconnecté de " + serveur + "/" + PORTROBOTS);

        if (serveur != serveurCourant)
            return;

        dodo();
    });

    sockets[serveur].on("connect_error", function (err) {
        //trace("Erreur de connexion au serveur " + serveur + "/" + PORTROBOTS);
    });

    // WAKEUP
    sockets[serveur].on("clientsrobotdebout", function () { // TODO bientôt le serveur ne demandera même plus au robot de se réveiller : si on réceptionne la trame binaire alors réveil
        if (!init) {
            trace("Ce robot n'est pas initialisé");
            sockets[serveur].emit("serveurrobotdebout", false);
            return;
        }

        if (!initVideo) {
            trace("La vidéo n'est pas initialisée");
            sockets[serveur].emit("serveurrobotdebout", false);
            return;
        }

        if (serveurCourant) {
            trace("Ce robot est déjà utilisé depuis le serveur " + serveurCourant);
            sockets[serveur].emit("serveurrobotdebout", false);
            return;
        }
        serveurCourant = serveur;

        debout();

        sockets[serveur].emit("serveurrobotdebout", true); // Un robot doit confirmer au serveur que sa procédure de sortie de veille est réussie
    });

    // SLEEP
    sockets[serveur].on("clientsrobotdodo", function () { // TODO bientôt le serveur ne demandera même plus au robot de dormir : si on ne réceptionne plus de trames binaire depuis > X secondes alors mise en veille
        if (serveur != serveurCourant)
            return;

        dodo();
    });

    // PING SERVEUR ?
    sockets[serveur].on("echo", function (data) {
        sockets[serveur].emit("echo", {
            serveur: data,
            client: Date.now()
        });
    });

    // RECEIVE BINARY TRAME
    sockets[serveur].on("clientsrobottx", function (data) { // Récepteur de la trame binaire
        if (serveur != serveurCourant)
            return;

        let now = Date.now();

        lastTimestamp = data.boucleVideoCommande;
        latence = now - data.boucleVideoCommande;

        if (data.data[0] != FRAME0 ||
            data.data[1] != FRAME1S) {
            if (data.data[1] == FRAME1T) {
                trace("Réception d'une trame texte");
                serial.write(data.data);
            } else
                trace("Réception d'une trame corrompue");
            return;
        }

        if (now - lastTrame < TXRATE / 2)
            return;

        lastTrame = now;

        for (let i = 0; i < tx.byteLength; i++)
            tx.bytes[i] = data.data[i];

        if (latence > LATENCEDEBUTALARME) {
            //trace("Réception d'une trame avec trop de latence");
            for (let i = 0; i < conf.TX.VITESSES.length; i++)
                tx.vitesses[i] = 0;
        } else
            serial.write(data.data);

        let camera = tx.choixCameras[0];
        if (camera != oldCamera) {
            confVideo = hard.CAMERAS[camera];
            if (up) {
                sigterm("Diffusion", PROCESSDIFFUSION, function (code) {
                    configurationVideo(function (code) {
                        diffusion();
                    });
                });
            } else
                configurationVideo(function (code) {
                });
            oldCamera = camera;
        }

        if (boostVideo != oldBoostVideo) {
            if (boostVideo) {
                exec("v4l2-ctl", V4L2 + " -c brightness=" + BOOSTVIDEOLUMINOSITE +
                    ",contrast=" + BOOSTVIDEOCONTRASTE, function (code) {
                    });
            } else {
                exec("v4l2-ctl", V4L2 + " -c brightness=" + confVideo.LUMINOSITE +
                    ",contrast=" + confVideo.CONTRASTE, function (code) {
                    });
            }
            oldBoostVideo = boostVideo;
        }

        if (!hard.DEVTELEMETRIE) {
            rx.sync[1] = FRAME1R;
            for (let i = 0; i < conf.TX.OUTILS.length; i++)
                rx.outils[i] = tx.outils[i];
            rx.choixCameras[0] = tx.choixCameras[0];
            for (let i = 0; i < conf.TX.VITESSES.length; i++)
                rx.vitesses[i] = tx.vitesses[i];
            rx.interrupteurs[0] = tx.interrupteurs[0];

            sockets[serveur].emit("serveurrobotrx", {
                timestamp: now,
                data: rx.arrayBuffer
            });
        }
    });

});

// setInterval(function () { // Calcul prédictif de latence et action sur le flux montant pour réduire la saturation de la websocket
//     if (!up || !init)
//         return;

//     let latencePredictive = Math.max(latence, Date.now() - lastTimestamp);

//     if (latencePredictive < LATENCEFINALARME && alarmeLatence) {
//         trace("Latence de " + latencePredictive + " ms, retour au débit vidéo configuré");
//         exec("v4l2-ctl", V4L2 + " -c video_bitrate=" + confVideo.BITRATE, function (code) {
//         });
//         alarmeLatence = false;
//     } else if (latencePredictive > LATENCEDEBUTALARME && !alarmeLatence) {
//         trace("Latence de " + latencePredictive + " ms, passage en débit vidéo réduit");
//         exec("v4l2-ctl", V4L2 + " -c video_bitrate=" + BITRATEVIDEOFAIBLE, function (code) {
//         });
//         alarmeLatence = true;
//     }
// }, TXRATE);

// VIDEO FLUX
NET.createServer(function (socket) { // Générateur du flux montant vidéo H.264
    const SPLITTER = new SPLIT(SEPARATEURNALU);

    trace("Le processus de diffusion vidéo H.264 est connecté sur tcp://127.0.0.1:" + PORTTCPVIDEO);

    SPLITTER.on("data", function (data) {

        if (serveurCourant) {
            // send video data
            sockets[serveurCourant].emit("serveurrobotvideo", {
                timestamp: Date.now(),
                data: data
            });
        }

    }).on("error", function (err) {
        trace("Erreur lors du découpage du flux d'entrée en unités de couche d'abstraction réseau H.264");
    });

    socket.pipe(SPLITTER);

    socket.on("end", function () {
        trace("Le processus de diffusion vidéo H.264 est déconnecté de tcp://127.0.0.1:" + PORTTCPVIDEO);
    });

}).listen(PORTTCPVIDEO);

// Good idea!!
process.on("uncaughtException", function (err) {
    let i = 0;
    let erreur = err.stack.split("\n");

    while (i < erreur.length)
        trace(erreur[i++]);

    trace("Suite à cette exception non interceptée, le processus Node.js va être terminé automatiquement");
    setTimeout(function () {
        process.exit(1);
    }, 1000);
})

trace("Client prêt");
