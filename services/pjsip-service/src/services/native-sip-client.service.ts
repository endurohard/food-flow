import { EventEmitter } from 'events';
import dgram from 'dgram';
import net from 'net';
import crypto from 'crypto';
import { SIPConfig, SIPUser, Call, CallStatus } from '../models/call.model.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Native SIP client using UDP/TCP transport
 * Implements basic SIP protocol without WebSocket dependency
 */
export class NativeSIPClientService extends EventEmitter {
  private config: SIPConfig;
  private socket: dgram.Socket | net.Socket | null = null;
  private activeCalls: Map<string, Call> = new Map();
  private registeredUsers: Set<string> = new Set();
  private callIdMap: Map<string, string> = new Map(); // SIP Call-ID -> our Call ID
  private sequenceNumber: number = 1;
  private localPort: number = 5060;
  private tags: Map<string, string> = new Map();

  constructor(config: SIPConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      logger.info('Connecting to SIP server via native transport...');

      if (this.config.transport === 'TCP') {
        await this.connectTCP();
      } else {
        await this.connectUDP();
      }

      // Register all users
      for (const user of this.config.users) {
        await this.registerUser(user);
      }

      logger.info(`Successfully connected ${this.config.users.length} SIP users via native transport`);
      this.emit('connected');
    } catch (error) {
      logger.error('Failed to connect to SIP server via native transport:', error);
      this.emit('error', error);
      throw error;
    }
  }

  private async connectUDP(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('message', (msg, rinfo) => {
        this.handleSIPMessage(msg.toString(), rinfo);
      });

      this.socket.on('error', (error) => {
        logger.error('UDP socket error:', error);
        reject(error);
      });

      this.socket.bind(this.localPort, () => {
        logger.info(`UDP socket listening on port ${this.localPort}`);
        resolve();
      });
    });
  }

  private async connectTCP(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({
        host: this.config.server,
        port: this.config.port || 5060
      });

      this.socket.on('connect', () => {
        logger.info(`TCP connected to ${this.config.server}:${this.config.port}`);
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleSIPMessage(data.toString(), null);
      });

      this.socket.on('error', (error) => {
        logger.error('TCP socket error:', error);
        reject(error);
      });
    });
  }

  private async registerUser(user: SIPUser): Promise<void> {
    const callId = this.generateCallId();
    const tag = this.generateTag();
    const branch = this.generateBranch();

    const registerMessage = this.buildREGISTER(user, callId, tag, branch);

    await this.sendSIPMessage(registerMessage);

    this.tags.set(user.extension, tag);
    this.registeredUsers.add(user.extension);

    logger.info(`REGISTER sent for user: ${user.username} (${user.extension})`);
  }

  private buildREGISTER(user: SIPUser, callId: string, tag: string, branch: string): string {
    const uri = `sip:${this.config.server}`;
    const from = `sip:${user.username}@${this.config.server}`;
    const contact = `sip:${user.username}@${this.getLocalIP()}:${this.localPort}`;

    return [
      `REGISTER ${uri} SIP/2.0`,
      `Via: SIP/2.0/${this.config.transport || 'UDP'} ${this.getLocalIP()}:${this.localPort};branch=${branch}`,
      `From: <${from}>;tag=${tag}`,
      `To: <${from}>`,
      `Call-ID: ${callId}`,
      `CSeq: ${this.sequenceNumber++} REGISTER`,
      `Contact: <${contact}>`,
      `Expires: 3600`,
      `Max-Forwards: 70`,
      `User-Agent: FoodFlow-PJSIP/1.0`,
      `Content-Length: 0`,
      '',
      ''
    ].join('\r\n');
  }

  private buildINVITE(from: string, to: string, user: SIPUser): string {
    const callId = this.generateCallId();
    const tag = this.generateTag();
    const branch = this.generateBranch();

    const fromUri = `sip:${user.username}@${this.config.server}`;
    const toUri = `sip:${to}@${this.config.server}`;
    const requestUri = toUri;
    const contact = `sip:${user.username}@${this.getLocalIP()}:${this.localPort}`;

    // Simple SDP for audio call
    const sdp = [
      'v=0',
      `o=${user.username} ${Date.now()} ${Date.now()} IN IP4 ${this.getLocalIP()}`,
      's=FoodFlow Call',
      `c=IN IP4 ${this.getLocalIP()}`,
      't=0 0',
      'm=audio 5004 RTP/AVP 0 8 101',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=sendrecv'
    ].join('\r\n');

    const message = [
      `INVITE ${requestUri} SIP/2.0`,
      `Via: SIP/2.0/${this.config.transport || 'UDP'} ${this.getLocalIP()}:${this.localPort};branch=${branch}`,
      `From: <${fromUri}>;tag=${tag}`,
      `To: <${toUri}>`,
      `Call-ID: ${callId}`,
      `CSeq: ${this.sequenceNumber++} INVITE`,
      `Contact: <${contact}>`,
      `Max-Forwards: 70`,
      `User-Agent: FoodFlow-PJSIP/1.0`,
      `Content-Type: application/sdp`,
      `Content-Length: ${sdp.length}`,
      '',
      sdp
    ].join('\r\n');

    return message;
  }

  private buildBYE(callId: string): string {
    const call = this.activeCalls.get(callId);
    if (!call) {
      throw new Error(`No active call: ${callId}`);
    }

    const user = this.config.users.find(u => u.extension === call.extension);
    if (!user) {
      throw new Error(`User not found: ${call.extension}`);
    }

    const tag = this.tags.get(call.extension) || this.generateTag();
    const branch = this.generateBranch();

    const fromUri = `sip:${user.username}@${this.config.server}`;
    const toUri = `sip:${call.direction === 'outbound' ? call.to : call.from}@${this.config.server}`;

    return [
      `BYE ${toUri} SIP/2.0`,
      `Via: SIP/2.0/${this.config.transport || 'UDP'} ${this.getLocalIP()}:${this.localPort};branch=${branch}`,
      `From: <${fromUri}>;tag=${tag}`,
      `To: <${toUri}>`,
      `Call-ID: ${call.callId}`,
      `CSeq: ${this.sequenceNumber++} BYE`,
      `Max-Forwards: 70`,
      `User-Agent: FoodFlow-PJSIP/1.0`,
      `Content-Length: 0`,
      '',
      ''
    ].join('\r\n');
  }

  private handleSIPMessage(message: string, rinfo: any): void {
    logger.debug('Received SIP message:', message.substring(0, 100));

    try {
      const lines = message.split('\r\n');
      const firstLine = lines[0];

      if (firstLine.startsWith('SIP/2.0')) {
        // Response
        this.handleSIPResponse(message, lines);
      } else {
        // Request
        this.handleSIPRequest(message, lines);
      }
    } catch (error) {
      logger.error('Error handling SIP message:', error);
    }
  }

  private handleSIPResponse(message: string, lines: string[]): void {
    const statusLine = lines[0];
    const statusCode = parseInt(statusLine.split(' ')[1]);
    const method = this.extractHeader(lines, 'CSeq')?.split(' ')[1];

    logger.info(`Received SIP response: ${statusCode} for ${method}`);

    if (method === 'REGISTER') {
      if (statusCode === 200) {
        logger.info('REGISTER successful');
      } else if (statusCode === 401 || statusCode === 407) {
        logger.warn('REGISTER requires authentication - not implemented yet');
        // TODO: Implement digest authentication
      }
    } else if (method === 'INVITE') {
      const callIdHeader = this.extractHeader(lines, 'Call-ID');
      const ourCallId = this.callIdMap.get(callIdHeader || '');

      if (ourCallId) {
        const call = this.activeCalls.get(ourCallId);
        if (call) {
          if (statusCode === 180 || statusCode === 183) {
            call.status = CallStatus.RINGING;
            this.emit('call:ringing', call);
          } else if (statusCode === 200) {
            call.status = CallStatus.ANSWERED;
            call.answerTime = new Date();
            this.emit('call:answered', call);
          } else if (statusCode >= 400) {
            call.status = CallStatus.FAILED;
            call.endTime = new Date();
            this.emit('call:failed', call);
            this.activeCalls.delete(ourCallId);
          }
        }
      }
    }
  }

  private handleSIPRequest(message: string, lines: string[]): void {
    const requestLine = lines[0];
    const method = requestLine.split(' ')[0];

    logger.info(`Received SIP request: ${method}`);

    if (method === 'INVITE') {
      this.handleIncomingINVITE(lines);
    } else if (method === 'BYE') {
      this.handleIncomingBYE(lines);
    } else if (method === 'CANCEL') {
      this.handleIncomingCANCEL(lines);
    }
  }

  private handleIncomingINVITE(lines: string[]): void {
    const fromHeader = this.extractHeader(lines, 'From');
    const toHeader = this.extractHeader(lines, 'To');
    const callIdHeader = this.extractHeader(lines, 'Call-ID');

    if (!fromHeader || !toHeader || !callIdHeader) {
      logger.error('Invalid INVITE: missing headers');
      return;
    }

    const fromMatch = fromHeader.match(/sip:([^@]+)@/);
    const toMatch = toHeader.match(/sip:([^@]+)@/);

    if (!fromMatch || !toMatch) {
      logger.error('Invalid INVITE: cannot parse URIs');
      return;
    }

    const from = fromMatch[1];
    const to = toMatch[1];

    const callId = uuidv4();
    const call: Call = {
      id: callId,
      callId: callIdHeader,
      sessionId: callIdHeader,
      direction: 'inbound',
      from: from,
      to: to,
      extension: to,
      status: CallStatus.RINGING,
      startTime: new Date()
    };

    this.activeCalls.set(callId, call);
    this.callIdMap.set(callIdHeader, callId);

    logger.info(`Incoming call (Native): ${from} -> ${to}`);

    this.emit('call:new', call);
    this.emit('call:ringing', call);

    // Send 180 Ringing
    const ringingResponse = this.build180Ringing(lines);
    this.sendSIPMessage(ringingResponse);
  }

  private handleIncomingBYE(lines: string[]): void {
    const callIdHeader = this.extractHeader(lines, 'Call-ID');
    const ourCallId = this.callIdMap.get(callIdHeader || '');

    if (ourCallId) {
      const call = this.activeCalls.get(ourCallId);
      if (call) {
        call.status = CallStatus.ENDED;
        call.endTime = new Date();
        if (call.answerTime) {
          call.duration = Math.floor((call.endTime.getTime() - call.answerTime.getTime()) / 1000);
        }
        this.emit('call:ended', call);
        this.activeCalls.delete(ourCallId);
        this.callIdMap.delete(callIdHeader || '');
      }
    }

    // Send 200 OK
    const okResponse = this.build200OK(lines, 'BYE');
    this.sendSIPMessage(okResponse);
  }

  private handleIncomingCANCEL(lines: string[]): void {
    const callIdHeader = this.extractHeader(lines, 'Call-ID');
    const ourCallId = this.callIdMap.get(callIdHeader || '');

    if (ourCallId) {
      const call = this.activeCalls.get(ourCallId);
      if (call) {
        call.status = CallStatus.CANCELLED;
        call.endTime = new Date();
        this.emit('call:cancelled', call);
        this.activeCalls.delete(ourCallId);
        this.callIdMap.delete(callIdHeader || '');
      }
    }

    // Send 200 OK
    const okResponse = this.build200OK(lines, 'CANCEL');
    this.sendSIPMessage(okResponse);
  }

  private build180Ringing(requestLines: string[]): string {
    const viaHeader = this.extractHeader(requestLines, 'Via');
    const fromHeader = this.extractHeader(requestLines, 'From');
    const toHeader = this.extractHeader(requestLines, 'To');
    const callIdHeader = this.extractHeader(requestLines, 'Call-ID');
    const cseqHeader = this.extractHeader(requestLines, 'CSeq');

    const tag = this.generateTag();
    const toWithTag = toHeader ? toHeader.replace('>', `;tag=${tag}>`) : '';

    return [
      'SIP/2.0 180 Ringing',
      `Via: ${viaHeader || ''}`,
      `From: ${fromHeader || ''}`,
      `To: ${toWithTag}`,
      `Call-ID: ${callIdHeader || ''}`,
      `CSeq: ${cseqHeader || ''}`,
      `Content-Length: 0`,
      '',
      ''
    ].join('\r\n');
  }

  private build200OK(requestLines: string[], method: string): string {
    const viaHeader = this.extractHeader(requestLines, 'Via');
    const fromHeader = this.extractHeader(requestLines, 'From');
    const toHeader = this.extractHeader(requestLines, 'To');
    const callIdHeader = this.extractHeader(requestLines, 'Call-ID');
    const cseqHeader = this.extractHeader(requestLines, 'CSeq');

    return [
      'SIP/2.0 200 OK',
      `Via: ${viaHeader || ''}`,
      `From: ${fromHeader || ''}`,
      `To: ${toHeader || ''}`,
      `Call-ID: ${callIdHeader || ''}`,
      `CSeq: ${cseqHeader || ''}`,
      `Content-Length: 0`,
      '',
      ''
    ].join('\r\n');
  }

  private extractHeader(lines: string[], headerName: string): string | null {
    for (const line of lines) {
      if (line.toLowerCase().startsWith(headerName.toLowerCase() + ':')) {
        return line.substring(headerName.length + 1).trim();
      }
    }
    return null;
  }

  async makeCall(from: string, to: string, autoAnswer: boolean = false): Promise<Call> {
    const user = this.config.users.find(u => u.extension === from);
    if (!user) {
      throw new Error(`No registered user for extension: ${from}`);
    }

    const inviteMessage = this.buildINVITE(from, to, user);
    const sipCallId = this.extractHeader(inviteMessage.split('\r\n'), 'Call-ID');

    const callId = uuidv4();
    const call: Call = {
      id: callId,
      callId: sipCallId || this.generateCallId(),
      sessionId: sipCallId || this.generateCallId(),
      direction: 'outbound',
      from: from,
      to: to,
      extension: from,
      status: CallStatus.INITIATING,
      startTime: new Date()
    };

    this.activeCalls.set(callId, call);
    if (sipCallId) {
      this.callIdMap.set(sipCallId, callId);
    }

    await this.sendSIPMessage(inviteMessage);

    logger.info(`Outbound call initiated (Native): ${from} -> ${to}`);

    this.emit('call:new', call);

    return call;
  }

  async answerCall(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      throw new Error(`No active call: ${callId}`);
    }

    // In a real implementation, we would send 200 OK with SDP here
    logger.info(`Call answered: ${callId}`);
    call.status = CallStatus.ANSWERED;
    call.answerTime = new Date();
    this.emit('call:answered', call);
  }

  async hangupCall(callId: string): Promise<void> {
    const byeMessage = this.buildBYE(callId);
    await this.sendSIPMessage(byeMessage);

    const call = this.activeCalls.get(callId);
    if (call) {
      call.status = CallStatus.ENDED;
      call.endTime = new Date();
      if (call.answerTime) {
        call.duration = Math.floor((call.endTime.getTime() - call.answerTime.getTime()) / 1000);
      }
      this.emit('call:ended', call);
      this.activeCalls.delete(callId);
      this.callIdMap.delete(call.callId);
    }

    logger.info(`Call hung up: ${callId}`);
  }

  async holdCall(callId: string): Promise<void> {
    // Hold/unhold requires re-INVITE with modified SDP
    logger.warn('Hold not implemented in native client yet');
    throw new Error('Hold not implemented');
  }

  async unholdCall(callId: string): Promise<void> {
    logger.warn('Unhold not implemented in native client yet');
    throw new Error('Unhold not implemented');
  }

  async transferCall(callId: string, target: string): Promise<void> {
    logger.warn('Transfer not implemented in native client yet');
    throw new Error('Transfer not implemented');
  }

  private async sendSIPMessage(message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket instanceof dgram.Socket) {
        this.socket.send(message, this.config.port || 5060, this.config.server, (error) => {
          if (error) {
            logger.error('Failed to send UDP message:', error);
            reject(error);
          } else {
            resolve();
          }
        });
      } else if (this.socket instanceof net.Socket) {
        this.socket.write(message, (error) => {
          if (error) {
            logger.error('Failed to send TCP message:', error);
            reject(error);
          } else {
            resolve();
          }
        });
      } else {
        reject(new Error('No socket connection'));
      }
    });
  }

  getActiveCalls(): Call[] {
    return Array.from(this.activeCalls.values());
  }

  getCallById(callId: string): Call | undefined {
    return this.activeCalls.get(callId);
  }

  isConnected(): boolean {
    return this.socket !== null && this.registeredUsers.size > 0;
  }

  async disconnect(): Promise<void> {
    logger.info('Disconnecting native SIP client...');

    // Hangup all active calls
    for (const [callId] of this.activeCalls.entries()) {
      try {
        await this.hangupCall(callId);
      } catch (error) {
        logger.error(`Error hanging up call ${callId}:`, error);
      }
    }

    // Close socket
    if (this.socket) {
      if (this.socket instanceof dgram.Socket) {
        this.socket.close();
      } else if (this.socket instanceof net.Socket) {
        this.socket.end();
      }
      this.socket = null;
    }

    this.registeredUsers.clear();
    this.activeCalls.clear();
    this.callIdMap.clear();

    this.emit('disconnected');
    logger.info('Disconnected from SIP server (Native)');
  }

  private generateCallId(): string {
    return `${uuidv4()}@${this.getLocalIP()}`;
  }

  private generateTag(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private generateBranch(): string {
    return `z9hG4bK-${crypto.randomBytes(16).toString('hex')}`;
  }

  private getLocalIP(): string {
    // Simple implementation - in production, use proper network interface detection
    return '127.0.0.1';
  }
}
