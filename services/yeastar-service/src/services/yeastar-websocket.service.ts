import WebSocket from 'ws';
import axios from 'axios';
import { EventEmitter } from 'events';
import { YeastarCallEvent, YeastarConfig, Call } from '../models/call.model';
import { logger } from '../utils/logger';

export class YeastarWebSocketService extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: YeastarConfig;
  private token: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private activeCalls: Map<string, Call> = new Map();

  constructor(config: YeastarConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      // Step 1: Authenticate and get token
      await this.authenticate();

      if (!this.token) {
        throw new Error('Failed to obtain authentication token');
      }

      // Step 2: Establish WebSocket connection
      const wsUrl = `wss://${this.config.host}:${this.config.port}/openapi/${this.config.apiVersion}/websocket`;

      logger.info(`Connecting to Yeastar WebSocket: ${wsUrl}`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        },
        rejectUnauthorized: false // For self-signed certificates
      });

      this.setupWebSocketHandlers();

    } catch (error) {
      logger.error('Failed to connect to Yeastar:', error);
      this.scheduleReconnect();
    }
  }

  private async authenticate(): Promise<void> {
    try {
      const authUrl = `https://${this.config.host}:${this.config.port}/openapi/${this.config.apiVersion}/login`;

      logger.info('Authenticating with Yeastar PBX...');

      const response = await axios.post(authUrl, {
        username: this.config.username,
        password: this.config.password
      }, {
        httpsAgent: new (require('https').Agent)({
          rejectUnauthorized: false
        })
      });

      if (response.data && response.data.access_token) {
        this.token = response.data.access_token;
        logger.info('Successfully authenticated with Yeastar');
      } else {
        throw new Error('No access token in response');
      }

    } catch (error) {
      logger.error('Authentication failed:', error);
      throw error;
    }
  }

  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      logger.info('WebSocket connection established');
      this.isConnected = true;
      this.emit('connected');
      this.startHeartbeat();

      // Subscribe to call events
      this.subscribeToEvents();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        logger.error('Failed to parse WebSocket message:', error);
      }
    });

    this.ws.on('error', (error) => {
      logger.error('WebSocket error:', error);
      this.emit('error', error);
    });

    this.ws.on('close', () => {
      logger.warn('WebSocket connection closed');
      this.isConnected = false;
      this.emit('disconnected');
      this.stopHeartbeat();
      this.scheduleReconnect();
    });
  }

  private handleMessage(message: any): void {
    logger.debug('Received message:', message);

    // Handle different event types
    if (message.event) {
      switch (message.event) {
        case 'NewCdr':
          this.handleNewCall(message);
          break;
        case 'CallStatus':
          this.handleCallStatus(message);
          break;
        case 'CallRinging':
          this.handleCallRinging(message);
          break;
        case 'CallAnswered':
          this.handleCallAnswered(message);
          break;
        case 'CallEnded':
          this.handleCallEnded(message);
          break;
        case 'ExtensionStatus':
          this.handleExtensionStatus(message);
          break;
        case 'Heartbeat':
          logger.debug('Heartbeat received');
          break;
        default:
          logger.debug(`Unhandled event type: ${message.event}`);
      }
    }
  }

  private handleNewCall(event: YeastarCallEvent): void {
    logger.info('New call detected:', event.callid);

    const call: Call = {
      id: event.callid,
      callId: event.callid,
      direction: this.determineCallDirection(event),
      from: this.getCallerNumber(event),
      to: this.getCalledNumber(event),
      extension: this.getExtension(event),
      status: 'ringing',
      startTime: new Date(event.timestamp * 1000),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.activeCalls.set(call.callId, call);
    this.emit('call:new', call);
  }

  private handleCallRinging(event: YeastarCallEvent): void {
    logger.info('Call ringing:', event.callid);

    const call = this.activeCalls.get(event.callid);
    if (call) {
      call.status = 'ringing';
      call.updatedAt = new Date();
      this.emit('call:ringing', call);
    }
  }

  private handleCallAnswered(event: YeastarCallEvent): void {
    logger.info('Call answered:', event.callid);

    const call = this.activeCalls.get(event.callid);
    if (call) {
      call.status = 'answered';
      call.answerTime = new Date(event.timestamp * 1000);
      call.updatedAt = new Date();
      this.emit('call:answered', call);
    }
  }

  private handleCallEnded(event: YeastarCallEvent): void {
    logger.info('Call ended:', event.callid);

    const call = this.activeCalls.get(event.callid);
    if (call) {
      call.status = 'ended';
      call.endTime = new Date(event.timestamp * 1000);

      if (call.answerTime) {
        call.duration = Math.floor((call.endTime.getTime() - call.answerTime.getTime()) / 1000);
      } else {
        call.status = 'missed';
      }

      call.updatedAt = new Date();
      this.emit('call:ended', call);

      // Remove from active calls
      this.activeCalls.delete(event.callid);
    }
  }

  private handleCallStatus(event: any): void {
    logger.debug('Call status update:', event);
    this.emit('call:status', event);
  }

  private handleExtensionStatus(event: any): void {
    logger.debug('Extension status:', event);
    this.emit('extension:status', event);
  }

  private subscribeToEvents(): void {
    if (!this.ws || !this.isConnected) return;

    const subscribeMessage = {
      action: 'subscribe',
      events: [
        'NewCdr',
        'CallStatus',
        'CallRinging',
        'CallAnswered',
        'CallEnded',
        'ExtensionStatus'
      ]
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    logger.info('Subscribed to Yeastar events');
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.send(JSON.stringify({ action: 'heartbeat' }));
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

  private determineCallDirection(event: YeastarCallEvent): 'inbound' | 'outbound' {
    if (event.members && event.members.length > 0) {
      return event.members[0].inbound ? 'inbound' : 'outbound';
    }
    return 'inbound';
  }

  private getCallerNumber(event: YeastarCallEvent): string {
    if (event.members && event.members.length > 0) {
      const member = event.members[0];
      if (member.inbound) {
        return member.inbound.from;
      } else if (member.outbound) {
        return member.outbound.from;
      }
    }
    return 'Unknown';
  }

  private getCalledNumber(event: YeastarCallEvent): string {
    if (event.members && event.members.length > 0) {
      const member = event.members[0];
      if (member.inbound) {
        return member.inbound.to;
      } else if (member.outbound) {
        return member.outbound.to;
      }
    }
    return 'Unknown';
  }

  private getExtension(event: YeastarCallEvent): string {
    if (event.members && event.members.length > 0) {
      return event.members[0].ext.number;
    }
    return 'Unknown';
  }

  // Click-to-call functionality
  async makeCall(from: string, to: string, autoAnswer: boolean = true): Promise<any> {
    try {
      const apiUrl = `https://${this.config.host}:${this.config.port}/openapi/${this.config.apiVersion}/call/dial`;

      const response = await axios.post(apiUrl, {
        caller: from,
        callee: to,
        autoanswer: autoAnswer ? 'yes' : 'no'
      }, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        httpsAgent: new (require('https').Agent)({
          rejectUnauthorized: false
        })
      });

      logger.info(`Click-to-call initiated: ${from} -> ${to}`);
      return response.data;

    } catch (error) {
      logger.error('Click-to-call failed:', error);
      throw error;
    }
  }

  // Hang up a call
  async hangupCall(callId: string): Promise<any> {
    try {
      const apiUrl = `https://${this.config.host}:${this.config.port}/openapi/${this.config.apiVersion}/call/hangup`;

      const response = await axios.post(apiUrl, {
        callid: callId
      }, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        httpsAgent: new (require('https').Agent)({
          rejectUnauthorized: false
        })
      });

      logger.info(`Call ${callId} hung up`);
      return response.data;

    } catch (error) {
      logger.error('Hangup failed:', error);
      throw error;
    }
  }

  // Get extension status
  async getExtensionStatus(extension: string): Promise<any> {
    try {
      const apiUrl = `https://${this.config.host}:${this.config.port}/openapi/${this.config.apiVersion}/extension/query`;

      const response = await axios.post(apiUrl, {
        number: extension
      }, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        httpsAgent: new (require('https').Agent)({
          rejectUnauthorized: false
        })
      });

      return response.data;

    } catch (error) {
      logger.error('Failed to get extension status:', error);
      throw error;
    }
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

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.activeCalls.clear();
    logger.info('Disconnected from Yeastar');
  }
}

export const createYeastarService = (config: YeastarConfig): YeastarWebSocketService => {
  return new YeastarWebSocketService(config);
};
