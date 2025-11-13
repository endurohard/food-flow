import { EventEmitter } from 'events';
import { SIPConfig, Call } from '../models/call.model.js';
import { WebSocketSIPClientService } from './websocket-sip-client.service.js';
import { NativeSIPClientService } from './native-sip-client.service.js';
import { logger } from '../utils/logger.js';

/**
 * SIP Connection Manager
 * Manages switching between WebSocket and Native SIP transports
 */
export class SIPConnectionManager extends EventEmitter {
  private config: SIPConfig;
  private activeClient: WebSocketSIPClientService | NativeSIPClientService | null = null;
  private connectionType: 'websocket' | 'native' = 'websocket';

  constructor(config: SIPConfig) {
    super();
    this.config = config;
    this.determineConnectionType();
  }

  private determineConnectionType(): void {
    if (this.config.useWebSocket || this.config.websocketUrl) {
      this.connectionType = 'websocket';
      logger.info('Using WebSocket transport for SIP');
    } else if (this.config.transport === 'WS' || this.config.transport === 'WSS') {
      this.connectionType = 'websocket';
      logger.info('Using WebSocket transport (WS/WSS)');
    } else {
      this.connectionType = 'native';
      logger.info(`Using native transport for SIP: ${this.config.transport}`);
    }
  }

  async connect(): Promise<void> {
    try {
      logger.info(`Connecting via ${this.connectionType} transport...`);

      if (this.connectionType === 'websocket') {
        this.activeClient = new WebSocketSIPClientService(this.config);
      } else {
        this.activeClient = new NativeSIPClientService(this.config);
      }

      // Forward all events from the client
      this.forwardClientEvents();

      await this.activeClient.connect();

      logger.info(`Successfully connected via ${this.connectionType} transport`);
      this.emit('connected', { type: this.connectionType });
    } catch (error) {
      logger.error(`Failed to connect via ${this.connectionType}:`, error);
      this.emit('error', error);
      throw error;
    }
  }

  private forwardClientEvents(): void {
    if (!this.activeClient) return;

    const events = [
      'connected',
      'disconnected',
      'error',
      'call:new',
      'call:ringing',
      'call:answered',
      'call:ended',
      'call:failed',
      'call:held',
      'call:resumed',
      'call:transferred',
      'call:cancelled'
    ];

    events.forEach(event => {
      this.activeClient!.on(event, (...args) => {
        this.emit(event, ...args);
      });
    });
  }

  async switchTransport(newConfig: SIPConfig): Promise<void> {
    logger.info('Switching SIP transport...');

    // Disconnect current client
    if (this.activeClient) {
      await this.activeClient.disconnect();
      this.activeClient.removeAllListeners();
      this.activeClient = null;
    }

    // Update config and determine new connection type
    this.config = newConfig;
    this.determineConnectionType();

    // Connect with new transport
    await this.connect();

    logger.info(`Successfully switched to ${this.connectionType} transport`);
    this.emit('transport:switched', { type: this.connectionType });
  }

  async makeCall(from: string, to: string, autoAnswer: boolean = false): Promise<Call> {
    if (!this.activeClient) {
      throw new Error('No active SIP client connection');
    }
    return this.activeClient.makeCall(from, to, autoAnswer);
  }

  async answerCall(callId: string): Promise<void> {
    if (!this.activeClient) {
      throw new Error('No active SIP client connection');
    }
    return this.activeClient.answerCall(callId);
  }

  async hangupCall(callId: string): Promise<void> {
    if (!this.activeClient) {
      throw new Error('No active SIP client connection');
    }
    return this.activeClient.hangupCall(callId);
  }

  async holdCall(callId: string): Promise<void> {
    if (!this.activeClient) {
      throw new Error('No active SIP client connection');
    }
    return this.activeClient.holdCall(callId);
  }

  async unholdCall(callId: string): Promise<void> {
    if (!this.activeClient) {
      throw new Error('No active SIP client connection');
    }
    return this.activeClient.unholdCall(callId);
  }

  async transferCall(callId: string, target: string): Promise<void> {
    if (!this.activeClient) {
      throw new Error('No active SIP client connection');
    }
    return this.activeClient.transferCall(callId, target);
  }

  getActiveCalls(): Call[] {
    if (!this.activeClient) {
      return [];
    }
    return this.activeClient.getActiveCalls();
  }

  getCallById(callId: string): Call | undefined {
    if (!this.activeClient) {
      return undefined;
    }
    return this.activeClient.getCallById(callId);
  }

  isConnected(): boolean {
    if (!this.activeClient) {
      return false;
    }
    return this.activeClient.isConnected();
  }

  getConnectionType(): 'websocket' | 'native' {
    return this.connectionType;
  }

  getConnectionInfo(): { type: 'websocket' | 'native'; connected: boolean; config: SIPConfig } {
    return {
      type: this.connectionType,
      connected: this.isConnected(),
      config: this.config
    };
  }

  async disconnect(): Promise<void> {
    if (this.activeClient) {
      await this.activeClient.disconnect();
      this.activeClient.removeAllListeners();
      this.activeClient = null;
    }
    this.emit('disconnected');
    logger.info('SIP Connection Manager disconnected');
  }
}
