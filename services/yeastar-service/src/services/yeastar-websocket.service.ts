import { Socket } from 'net';
import { EventEmitter } from 'events';
import { YeastarCallEvent, YeastarConfig, Call } from '../models/call.model';
import { logger } from '../utils/logger';

export class YeastarWebSocketService extends EventEmitter {
  private socket: Socket | null = null;
  private config: YeastarConfig;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private activeCalls: Map<string, Call> = new Map();
  private buffer: string = '';
  private actionId: number = 1;

  constructor(config: YeastarConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      logger.info(`Connecting to Yeastar AMI: ${this.config.host}:${this.config.port}`);

      this.socket = new Socket();

      this.socket.connect(this.config.port, this.config.host, () => {
        logger.info('Connected to Yeastar AMI');
      });

      this.setupSocketHandlers();

    } catch (error) {
      logger.error('Failed to connect to Yeastar:', error);
      this.scheduleReconnect();
    }
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      logger.info('AMI socket connected, attempting login...');
      this.amiLogin();
    });

    this.socket.on('data', (data: Buffer) => {
      const dataStr = data.toString();
      logger.info('AMI Raw data received:', dataStr);
      this.buffer += dataStr;
      this.processBuffer();
    });

    this.socket.on('error', (error) => {
      logger.error('AMI socket error:', error);
      this.emit('error', error);
    });

    this.socket.on('close', () => {
      logger.warn('AMI connection closed');
      this.isConnected = false;
      this.emit('disconnected');
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.socket.on('end', () => {
      logger.info('AMI connection ended');
    });
  }

  private amiLogin(): void {
    const loginAction =
      `Action: Login\r\n` +
      `Username: ${this.config.username}\r\n` +
      `Secret: ${this.config.password}\r\n` +
      `ActionID: ${this.actionId++}\r\n` +
      `Events: on\r\n\r\n`;

    this.socket?.write(loginAction);
    logger.info('Sent AMI login request');
  }

  private processBuffer(): void {
    const messages = this.buffer.split('\r\n\r\n');

    // Keep the last incomplete message in the buffer
    this.buffer = messages.pop() || '';

    for (const message of messages) {
      if (message.trim()) {
        this.handleAMIMessage(message);
      }
    }
  }

  private handleAMIMessage(message: string): void {
    const lines = message.split('\r\n');
    const event: any = {};

    for (const line of lines) {
      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (match) {
        event[match[1]] = match[2];
      }
    }

    logger.info('AMI Message received:', event);

    if (event.Response === 'Success' && !this.isConnected) {
      logger.info('Successfully authenticated with Yeastar AMI');
      this.isConnected = true;
      this.emit('connected');
      this.startHeartbeat();
      this.subscribeToEvents();
    } else if (event.Response === 'Error') {
      logger.error('AMI Error:', event.Message);
    } else if (event.Event) {
      this.handleAMIEvent(event);
    }
  }

  private handleAMIEvent(event: any): void {
    switch (event.Event) {
      case 'Newchannel':
        this.handleNewChannel(event);
        break;
      case 'Newstate':
        this.handleNewState(event);
        break;
      case 'Dial':
        this.handleDial(event);
        break;
      case 'DialBegin':
        this.handleDialBegin(event);
        break;
      case 'DialEnd':
        this.handleDialEnd(event);
        break;
      case 'Hangup':
        this.handleHangup(event);
        break;
      case 'ExtensionStatus':
        this.handleExtensionStatus(event);
        break;
      case 'PeerStatus':
        this.handlePeerStatus(event);
        break;
      default:
        logger.debug(`Unhandled AMI event: ${event.Event}`);
    }
  }

  private handleNewChannel(event: any): void {
    logger.info('New channel:', event.Channel);

    const callId = event.Uniqueid;
    const call: Call = {
      id: callId,
      callId: callId,
      direction: event.CallerIDNum ? 'inbound' : 'outbound',
      from: event.CallerIDNum || 'Unknown',
      to: event.Exten || 'Unknown',
      extension: event.Exten || 'Unknown',
      status: 'ringing',
      startTime: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.activeCalls.set(callId, call);
    this.emit('call:new', call);
  }

  private handleNewState(event: any): void {
    const callId = event.Uniqueid;
    const call = this.activeCalls.get(callId);

    if (call) {
      const channelState = parseInt(event.ChannelState);

      // ChannelState: 0=Down, 4=Ring, 5=Ringing, 6=Up
      if (channelState === 4 || channelState === 5) {
        call.status = 'ringing';
        call.updatedAt = new Date();
        this.emit('call:ringing', call);
      } else if (channelState === 6) {
        call.status = 'answered';
        call.answerTime = new Date();
        call.updatedAt = new Date();
        this.emit('call:answered', call);
      }
    }
  }

  private handleDial(event: any): void {
    logger.info('Dial event:', event.DestChannel);
  }

  private handleDialBegin(event: any): void {
    const callId = event.DestUniqueid;
    let call = this.activeCalls.get(callId);

    if (!call) {
      call = {
        id: callId,
        callId: callId,
        direction: 'outbound',
        from: event.CallerIDNum || 'Unknown',
        to: event.DestCallerIDNum || 'Unknown',
        extension: event.CallerIDNum || 'Unknown',
        status: 'ringing',
        startTime: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      this.activeCalls.set(callId, call);
      this.emit('call:new', call);
    }
  }

  private handleDialEnd(event: any): void {
    const callId = event.DestUniqueid;
    const call = this.activeCalls.get(callId);

    if (call) {
      if (event.DialStatus === 'ANSWER') {
        call.status = 'answered';
        call.answerTime = new Date();
      } else {
        call.status = 'missed';
      }
      call.updatedAt = new Date();
    }
  }

  private handleHangup(event: any): void {
    const callId = event.Uniqueid;
    const call = this.activeCalls.get(callId);

    if (call) {
      call.status = 'ended';
      call.endTime = new Date();

      if (call.answerTime) {
        call.duration = Math.floor((call.endTime.getTime() - call.answerTime.getTime()) / 1000);
      } else {
        call.status = 'missed';
      }

      call.updatedAt = new Date();
      this.emit('call:ended', call);

      // Remove from active calls after a delay
      setTimeout(() => {
        this.activeCalls.delete(callId);
      }, 5000);
    }
  }

  private handlePeerStatus(event: any): void {
    logger.debug('Peer status:', event);
    this.emit('extension:status', event);
  }

  private handleExtensionStatus(event: any): void {
    logger.debug('Extension status:', event);
    this.emit('extension:status', event);
  }

  private subscribeToEvents(): void {
    // AMI sends all events when Events: on is set during login
    // No additional subscription needed
    logger.info('Subscribed to all AMI events');
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && this.isConnected) {
        const pingAction =
          `Action: Ping\r\n` +
          `ActionID: ${this.actionId++}\r\n\r\n`;
        this.socket.write(pingAction);
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      logger.info('Attempting to reconnect to Yeastar...');
      this.connect();
    }, this.config.reconnectInterval);
  }

  // Click-to-call functionality using AMI
  async makeCall(from: string, to: string, autoAnswer: boolean = true): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isConnected) {
        reject(new Error('Not connected to AMI'));
        return;
      }

      const actionId = this.actionId++;
      const originateAction =
        `Action: Originate\r\n` +
        `Channel: SIP/${from}\r\n` +
        `Exten: ${to}\r\n` +
        `Context: from-internal\r\n` +
        `Priority: 1\r\n` +
        `CallerID: ${from}\r\n` +
        `Timeout: 30000\r\n` +
        `ActionID: ${actionId}\r\n\r\n`;

      this.socket.write(originateAction);
      logger.info(`Click-to-call initiated: ${from} -> ${to}`);
      resolve({ success: true, actionId });
    });
  }

  // Hang up a call using AMI
  async hangupCall(channel: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isConnected) {
        reject(new Error('Not connected to AMI'));
        return;
      }

      const actionId = this.actionId++;
      const hangupAction =
        `Action: Hangup\r\n` +
        `Channel: ${channel}\r\n` +
        `ActionID: ${actionId}\r\n\r\n`;

      this.socket.write(hangupAction);
      logger.info(`Hangup requested for channel: ${channel}`);
      resolve({ success: true, actionId });
    });
  }

  // Get extension status using AMI
  async getExtensionStatus(extension: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isConnected) {
        reject(new Error('Not connected to AMI'));
        return;
      }

      const actionId = this.actionId++;
      const statusAction =
        `Action: ExtensionState\r\n` +
        `Exten: ${extension}\r\n` +
        `Context: from-internal\r\n` +
        `ActionID: ${actionId}\r\n\r\n`;

      this.socket.write(statusAction);
      resolve({ success: true, actionId });
    });
  }

  getActiveCalls(): Call[] {
    return Array.from(this.activeCalls.values());
  }

  getCallById(callId: string): Call | undefined {
    return this.activeCalls.get(callId);
  }

  isConnectionActive(): boolean {
    return this.isConnected;
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.socket) {
      const logoffAction =
        `Action: Logoff\r\n` +
        `ActionID: ${this.actionId++}\r\n\r\n`;

      this.socket.write(logoffAction);
      this.socket.end();
      this.socket = null;
    }

    this.isConnected = false;
    this.activeCalls.clear();
    logger.info('Disconnected from Yeastar AMI');
  }
}

export const createYeastarService = (config: YeastarConfig): YeastarWebSocketService => {
  return new YeastarWebSocketService(config);
};
