import * as events from 'events';
import * as net from 'net';
import * as dgram from 'dgram';
import { Buffer } from 'buffer';
import { TypedEmitter } from 'tiny-typed-emitter';

enum PacketType {
    COMMAND = 0x02,
    AUTH = 0x03,
    RESPONSE_VALUE = 0x00,
    RESPONSE_AUTH = 0x02,
};

interface Options {
    tcp?: boolean;
    challenge?: boolean;
    id?: number;
}

export interface RconEvents {
    'error': (err: any) => any;
    'server': (str: string) => any;
    'response': (str: string) => any;
    'auth': () => any;
    /**
     * emitted when connected to socket
     */
    'connect': () => any;
    'end': () => any;
}

export class Rcon extends TypedEmitter<RconEvents> {
    private host: string;
    private port: number;
    private password: string;
    private hasAuthed: boolean;
    private outstandingData: Uint8Array | null;
    private tcp: boolean;
    private challenge: boolean;
    private _challengeToken: string;
    private _tcpSocket!: net.Socket;
    private _udpSocket!: dgram.Socket;
    private _runningCommands!: Map<
    number,
    {
      resolve: (result: string | undefined) => void;
      reject: (err: any) => void;
    }
  >;

    constructor(host: string, port: number, password: string, options?: Options) {
        super();
        options = options || {};
        this.host = host;
        this.port = port;
        this.password = password;
        this.hasAuthed = false;
        this.outstandingData = null;
        this.tcp = options.tcp ? options.tcp : true;
        this.challenge = options.challenge ? options.challenge : true;
        this._challengeToken = '';
        this._runningCommands = new Map();

        events.EventEmitter.call(this);
    }

    public send = async (data: string, cmd?: PacketType): Promise<string | undefined> => {
        let sendBuf: Buffer;
        const id = Math.round(Math.random() * 0x7FFFFFFF);
        if (this.tcp) {
            cmd = cmd || PacketType.COMMAND;

            const length = Buffer.byteLength(data);
            sendBuf = Buffer.alloc(length + 14);
            sendBuf.writeInt32LE(length + 10, 0);
            sendBuf.writeInt32LE(id, 4);
            sendBuf.writeInt32LE(cmd, 8);
            sendBuf.write(data, 12);
            sendBuf.writeInt16LE(0, length + 12);

            this._sendSocket(sendBuf);
            const promise = new Promise<string | undefined>((resolve, reject) => {
                this._runningCommands.set(id, {
                    reject,
                    resolve,
                });
            });
            
            return promise;
        } else {
            if (this.challenge && !this._challengeToken) {
                this.emit('error', new Error('Not authenticated'));
                return;
            }
            let str = 'rcon ';
            if (this._challengeToken) str += this._challengeToken + ' ';
            if (this.password) str += this.password + ' ';
            str += data + '\n';
            sendBuf = Buffer.alloc(4 + Buffer.byteLength(str));
            sendBuf.writeInt32LE(-1, 0);
            sendBuf.write(str, 4);
            this._sendSocket(sendBuf);
            return Promise.resolve(undefined);
        }
    };

    private _sendSocket = (buf: Buffer) => {
        if (this._tcpSocket) {
            this._tcpSocket.write(buf.toString('binary'), 'binary');
        } else if (this._udpSocket) {
            this._udpSocket.send(buf, 0, buf.length, this.port, this.host);
        }
    };

    public connect = (): void => {
        if (this.tcp) {
            this._tcpSocket = net.createConnection(this.port, this.host);
            this._tcpSocket
                .on('data', data => {
                    this._tcpSocketOnData(data);
                })
                .on('connect', () => {
                    this.socketOnConnect();
                })
                .on('error', err => {
                    this.emit('error', err);
                })
                .on('end', () => {
                    this.socketOnEnd();
                });
        } else {
            this._udpSocket = dgram.createSocket('udp4');
            this._udpSocket
                .on('message', data => {
                    this._udpSocketOnData(data);
                })
                .on('listening', () => {
                    this.socketOnConnect();
                })
                .on('error', err => {
                    this.emit('error', err);
                })
                .on('close', () => {
                    this.socketOnEnd();
                });
            this._udpSocket.bind(0);
        }
    };

    public disconnect = (): void => {
        if (this._tcpSocket) this._tcpSocket.end();
        if (this._udpSocket) this._udpSocket.close();
    };

    public setTimeout = (timeout: number, callback: () => void): void => {
        if (!this._tcpSocket) return;
        this._tcpSocket.setTimeout(timeout, () => {
            this._tcpSocket.end();
            if (callback) callback();
        });
    };

    private _udpSocketOnData = (data: Buffer) => {
        const a = data.readUInt32LE(0);
        if (a === 0xffffffff) {
            const str = data.toString('utf-8', 4);
            const tokens = str.split(' ');
            if (
                tokens.length === 3 &&
                tokens[0] === 'challenge' &&
                tokens[1] === 'rcon'
            ) {
                this._challengeToken = tokens[2].substr(0, tokens[2].length - 1).trim();
                this.hasAuthed = true;
                this.emit('auth');
            } else {
                this.emit('response', str.substr(1, str.length - 2));
            }
        } else {
            this.emit('error', new Error('Received malformed packet'));
        }
    };

    private _tcpSocketOnData = (data: Buffer) => {
        if (this.outstandingData != null) {
            data = Buffer.concat(
                [this.outstandingData, data],
                this.outstandingData.length + data.length
            );
            this.outstandingData = null;
        }

        while (data.length) {
            const len = data.readInt32LE(0);
            if (!len) return;

            const id = data.readInt32LE(4);
            const type = data.readInt32LE(8);

            if (len >= 10 && data.length >= len + 4) {
                if (this._runningCommands.has(id)) {
                    if (!this.hasAuthed && type === PacketType.RESPONSE_AUTH) {
                        this.hasAuthed = true;
                        this.emit('auth');
                    } else if (type === PacketType.RESPONSE_VALUE) {
                        // Read just the body of the packet (truncate the last null byte)
                        // See https://developer.valvesoftware.com/wiki/Source_RCON_Protocol for details
                        let str = data.toString('utf8', 12, 12 + len - 10);

                        if (str.charAt(str.length - 1) === '\n') {
                            // Emit the response without the newline.
                            str = str.substring(0, str.length - 1);
                        }

                        this._runningCommands.get(id)?.resolve(str);
                        this._runningCommands.delete(id);
                    }
                } else if (id === -1) {
                    this.emit('error', new Error('Authentication failed'));
                } else {
                    let str = data.toString('utf8', 12, 12 + len - 10);

                    if (str.charAt(str.length - 1) === '\n') {
                        // Emit the response without the newline.
                        str = str.substring(0, str.length - 1);
                    }
                    this.emit('server', str);
                }

                data = data.slice(12 + len - 8);
            } else {
                // Keep a reference to the chunk if it doesn't represent a full packet
                this.outstandingData = data;
                break;
            }
        }
    };

    public socketOnConnect = (): void => {
        this.emit('connect');

        if (this.tcp) {
            this.send(this.password, PacketType.AUTH);
        } else if (this.challenge) {
            const str = 'challenge rcon\n';
            const sendBuf = Buffer.alloc(str.length + 4);
            sendBuf.writeInt32LE(-1, 0);
            sendBuf.write(str, 4);
            this._sendSocket(sendBuf);
        } else {
            const sendBuf = Buffer.alloc(5);
            sendBuf.writeInt32LE(-1, 0);
            sendBuf.writeUInt8(0, 4);
            this._sendSocket(sendBuf);

            this.hasAuthed = true;
            this.emit('auth');
        }
    };

    public socketOnEnd = (): void => {
        this.emit('end');
        this.hasAuthed = false;
    };
}