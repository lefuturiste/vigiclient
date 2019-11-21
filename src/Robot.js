const SocketIo = require('socket.io-client')

module.exports = class Robot {
    socket

    constructor () {

    }

    start () {
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
                version: '3x',
                processTime: 3,
                osTime: 3,
                ipPriv: 'ipPriv.trim()',
                ssid: 'ssid.trim()'
            });
        })
        this.socket.on("echo", (data) => {
            this.socket.emit("echo", {
                serveur: data,
                client: Date.now()
            });
        });
        this.socket.on('disconnect', () => {
            console.log('> socket disconnected')
        })
        this.socket.on('connect_error', () => {
            console.log('connect error')
        })
    } 
}