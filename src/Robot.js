const SocketIo = require('socket.io-client')
const Exec = require("child_process").exec
const Net = require('net')
const Os = require('os')

module.exports = class Robot {

    constructor() {
        this.socket = null
        this.config = {}
        this.lastTimestamp = Date.now()
        this.latence = 0
        this.lastTrame = Date.now()
        this.boostVideo = false
        this.oldBoostVideo = false
        this.alarmeLatence = false
    }

    start() {
        this.socket = SocketIo.connect(
            "https://www.vigibot.com",
            {
                "connect timeout": 1000,
                transports: ["websocket"],
                path: "/86/socket.io"
            }
        );
        this.socket.on('connect', () => {
            console.log('connect!')
            this.socket.emit("serveurrobotlogin", {
                conf: {
                    SERVEURS: [
                        "https://www.vigibot.com"
                    ],
                    NOM: "lefuturiste",
                    PASSWORD: "yBKEwPUrHMJtJJZVsey1"
                },
                version: '1574504514347',
                processTime: Date.now(),
                osTime: Date.now() - Os.uptime() * 1000,
                ipPriv: '192.168.0.23',
                ssid: 'qdsldsqlqdsldsqldlsqldsql!'
            });
        })
        this.socket.on("clientsrobotconf", (data) => {
            this.config = data
            this.videoInit()
        })
        this.socket.on("echo", (data) => {
            console.log(data)
            this.socket.emit("echo", {
                serveur: data,
                client: Date.now()
            });
        });

        this.socket.on("clientsrobottx", (data) => {
            
            this.now = Date.now()
            this.lastTimestamp = data.boucleVideoCommande
            this.latence = this.now - this.data.boucleVideoCommande
            this.boostVideo = false;
            this.oldBoostVideo = false;

            if (data.data[0] != FRAME0 ||
                data.data[1] != FRAME1S) {
                if (data.data[1] == FRAME1T) {
                    console.log("Réception d'une trame texte");
                    serial.write(data.data);
                } else
                    console.log("Réception d'une trame corrompue");
                return;
            }

            if (this.now - this.lastTrame < TXRATE / 2) {
                console.log('> TX Ignored')
                return;
            }

            this.lastTrame = this.now;

            if (this.boostVideo != this.oldBoostVideo) {
                if (this.boostVideo) {
                    Exec("/usr/bin/v4l2-ctl -c brightness=" + 80 + ",contrast=" + 100);
                } else {
                    Exec("/usr/bin/v4l2-ctl -c brightness=" + confVideo.LUMINOSITE + ",contrast=" + confVideo.CONTRASTE);
                }
                this.oldBoostVideo = this.boostVideo;
            }
        });
        this.socket.on('disconnect', () => {
            console.log('> socket disconnected')
        })
        this.socket.on('connect_error', () => {
            console.log('connect error')
        })
    }

    videoInit() {

        let diffusionProcessCommand = [
            "/usr/local/vigiclient/processdiffusion",
            " SOURCEVIDEO",
            " | /bin/nc 127.0.0.1 PORTTCPVIDEO",
            " -w 2"
        ]
        const videoTcpPort = 8010;
        const StreamSplit = require("stream-split");
        // VIDEO FLUX
        let videoLoopServer = Net.createServer((socket) => {
            console.log('> New socket')
            const StreamSplitter = new StreamSplit(new Buffer.from([0, 0, 0, 1]));

            StreamSplitter.on("data", (data) => {
                // send video data
                this.socket.emit("serveurrobotvideo", {
                    timestamp: Date.now(),
                    data: data
                });
            }).on('error', () => {
                console.log('> Stream splitter err') 
            })

            socket.pipe(StreamSplitter);
        })
        videoLoopServer.on('error', (err) => {
            console.log('> net err')
            console.log(err)
        })


        setTimeout(() => {
            let confVideo = {
                TYPE: '',
                SOURCE: '/dev/video0',
                WIDTH: 640,
                HEIGHT: 480,
                FPS: 30,
                BITRATE: 1500000,
                ROTATION: 180,
                LUMINOSITE: 50,
                CONTRASTE: -5
            }

            console.log("/usr/bin/v4l2-ctl -v width=" + confVideo.WIDTH +
                ",height=" + confVideo.HEIGHT +
                ",pixelformat=4" +
                " -p " + confVideo.FPS +
                " -c h264_profile=0" +
                ",repeat_sequence_header=1" +
                ",rotate=" + confVideo.ROTATION +
                ",video_bitrate=" + confVideo.BITRATE +
                ",brightness=" + confVideo.LUMINOSITE +
                ",contrast=" + confVideo.CONTRASTE)

            let video4LinuxProcess = Exec("/usr/bin/v4l2-ctl -v width=" + confVideo.WIDTH +
                ",height=" + confVideo.HEIGHT +
                ",pixelformat=4" +
                " -p " + confVideo.FPS +
                " -c h264_profile=0" +
                ",repeat_sequence_header=1" +
                ",rotate=" + confVideo.ROTATION +
                ",video_bitrate=" + confVideo.BITRATE +
                ",brightness=" + confVideo.LUMINOSITE +
                ",contrast=" + confVideo.CONTRASTE);

            video4LinuxProcess.stdout.on('data', (data) => {
                console.log('stdout', data)
            })
            video4LinuxProcess.stderr.on('data', (data) => {
                console.log('sterr')
            })
            video4LinuxProcess.on('close', () => {
                console.log('> Video4Linux Process close')
            })

            let cmdDiffusion = diffusionProcessCommand.join("")
                .replace("SOURCEVIDEO", confVideo.SOURCE)
                .replace("PORTTCPVIDEO", videoTcpPort)
                .replace("ROTATIONVIDEO", confVideo.ROTATION)
                .replace(new RegExp("BITRATEVIDEO", "g"), confVideo.BITRATE);

            let videoBroadcastProcess = Exec(cmdDiffusion)

            videoBroadcastProcess.stdout.on('data', (data) => {
                console.log('stdout', data)
            })
            videoBroadcastProcess.stderr.on('data', (data) => {
                console.log('sterr')
            })
            videoBroadcastProcess.on('exit', () => {
                console.log('> video broadcast process exit')
            })

            let latence = 0;
            let alarmeLatence = false;
            let lastTimestamp = Date.now();

            setInterval(function () { // Calcul prédictif de latence et action sur le flux montant pour réduire la saturation de la websocket
               
                const LATENCEFINALARME = 250;       // Repasse en débit vidéo configuré si la latence retombe sous cette valeur (fonction hystérésis min)
                const LATENCEDEBUTALARME = 500;     // Surcharge le débit vidéo configuré si la latence passe au dela de cette valeur (fonction hystérésis max)

                let latencePredictive = Math.max(this.latence, Date.now() - this.lastTimestamp);

                if (latencePredictive < LATENCEFINALARME && alarmeLatence) {
                    Exec("/usr/bin/v4l2-ctl -c video_bitrate=" + confVideo.BITRATE);
                    console.log('changed bitrate')
                    this.alarmeLatence = false;
                } else if (latencePredictive > LATENCEDEBUTALARME && !this.alarmeLatence) {
                    Exec("/usr/bin/v4l2-ctl -c video_bitrate=" + 100000);
                    console.log('changed bitrate')
                    this.alarmeLatence = true;
                }
            }, 50);

        }, 3000)
        videoLoopServer.listen(videoTcpPort, () => {
            console.log('> Internal video loop server started')
        });


    }


    configurationVideo(callback) {
        cmdDiffusion = CONF.CMDDIFFUSION.join("").replace("SOURCEVIDEO", confVideo.SOURCE
        ).replace("PORTTCPVIDEO", PORTTCPVIDEO
        ).replace("ROTATIONVIDEO", confVideo.ROTATION
        ).replace(new RegExp("BITRATEVIDEO", "g"), confVideo.BITRATE);
        cmdDiffAudio = CONF.CMDDIFFAUDIO.join("").replace("PORTTCPAUDIO", PORTTCPAUDIO);

        trace("Initialisation de la configuration Video4Linux");

        Exec(V4L2 + " -v width=" + confVideo.WIDTH +
            ",height=" + confVideo.HEIGHT +
            ",pixelformat=4" +
            " -p " + confVideo.FPS +
            " -c h264_profile=0" +
            ",repeat_sequence_header=1" +
            ",rotate=" + confVideo.ROTATION +
            ",video_bitrate=" + confVideo.BITRATE +
            ",brightness=" + confVideo.LUMINOSITE +
            ",contrast=" + confVideo.CONTRASTE);
    }

    diffusion() {
        console.log("Démarrage du flux de diffusion vidéo H.264");
        Exec(cmdDiffusion);
    }

}