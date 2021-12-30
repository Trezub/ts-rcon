# ts-rcon

[![npm](https://img.shields.io/npm/v/@trezub/ts-rcon)](https://img.shields.io/npm/v/@trezub/ts-rcon) [![CI](https://github.com/trezub/ts-rcon/actions/workflows/main.yml/badge.svg)](https://github.com/trezub/ts-rcon/actions/workflows/main.yml/badge.svg)

ts-rcon is a simple library for connecting to RCON servers in node.js implemented in TypeScript.
Based on [pushrax/node-rcon](https://github.com/pushrax/node-rcon).
It implements the protocol used by Valve's Source and GoldSrc engines,
as well as many other game servers.

It was originally created to connect to Minecraft's RCON server.

[RCON Protocol Docs](https://developer.valvesoftware.com/wiki/Source_RCON_Protocol)

## Installation

```shell
npm install ts-rcon
yarn add ts-rcon
```

## Usage

Some games use TCP and some use UDP for their RCON implementation. To tell
node-rcon which protocol to use, pass it an options object like so:

```javascript
const options = {
  tcp: false, // false for UDP, true for TCP (default true)
  challenge: false, // true to use the challenge protocol (default true)
};
const client = new Rcon(host, port, password, options);

client.on('auth', () => {
    // Awaiting only works when using tcp
    const players = await client.send('listplayers');
    console.log(players);

    // When using UDP, it should be used this way
    client.on('response', (str) => {
        console.log(str);
    });
    client.send('listplayers');
});

client.connect();

```

Here's a non-exhaustive list of which games use which options:

| Game                  | Protocol | Challenge |
| :---------------      | :------- | :-------- |
| Any Source game       | TCP      | N/A       |
| Minecraft             | TCP      | N/A       |
| Any GoldSrc game      | UDP      | Yes       |
| Call of Duty          | UDP      | No        |
| Ark: Survival Evolved | TCP      | No        |

Source games include CS:S, CS:GO, TF2, etc. GoldSrc games include CS 1.6, TFC,
Ricochet (lol), etc.

If there's a game you know uses a certain protocol, feel free to submit a pull
request.

Please submit a bug report for any game you try that doesn't work!
