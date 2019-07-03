# Make your own Vigibot.com raspberry PI robot

## Installation on a clean Raspbian Stretch Lite

### Prerequisites

- Flash the last Raspbian Stretch Lite image: https://www.vigibot.com/raspbian

- Put your "wpa_supplicant.conf" and an empty "ssh" file inside the boot partition

- Connect to your Raspberry Pi via SSH

- sudo raspi-config

- Enable camera and I2C

### Installation

- wget https://www.vigibot.com/vigiclient/install.sh

- sudo bash install.sh

- sudo nano /boot/robot.json

- Change "Demo" login and "Default" password to match your own robot account

- sudo reboot

- Take a look at the default server: https://www.vigibot.com

## Creation of a vigibot image

The vigimage.sh script permits to generate a raspbian image with the vigibot client directly installed.

vigimage.sh :
- download the latest stretch image from raspberrypi.org
- mounts the partitions
- install vigiclient dependencies and configurations file (install.sh)
- umount the partitions
- img is ready to be copied


```shell
# as root on a raspian pi
# first install dependencies
apt install -y wget zip unzip kpartx
# then creates the image
./vigimage --no-delete --create
```

