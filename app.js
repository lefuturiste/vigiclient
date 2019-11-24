let robot = require('./src/Robot.js')
robot = new robot()

robot.start()

// const vigiclient = require('vigiclient')

// vigiclient.setAuth('robotName', 'robotToken')

// vigiclient.on('connect', () => {
//     console.log('Robot connected and up!')
// })

// vigiclient.on('sleep', () => {
//     console.log('Bye bye')
// })

// vigiclient.on('wakeup', () => {
//     console.log('Good morning')
// })

// vigiclient.on('wakeup', () => {
//     console.log('Good morning')
// })

// vigiclient.start()


process.on("uncaughtException", function(err) {
    console.log(err)
    console.log('uncaughtException, exit')
    setTimeout(() => { process.exit(1) }, 1000)
})