import { EventEmitter } from 'events';
import { UserAgent, Registerer, Inviter, Session, SessionState } from 'sip.js';
import { SIPConfig, SIPUser, Call, CallStatus } from '../models/call.model.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

export class SIPClientService extends EventEmitter {
  private userAgents: Map<string, UserAgent> = new Map();
  private registerers: Map<string, Registerer> = new Map();
  private activeSessions: Map<string, Session> = new Map();
  private activeCalls: Map<string, Call> = new Map();
  private config: SIPConfig;

  constructor(config: SIPConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      logger.info('Connecting to SIP server...');

      for (const user of this.config.users) {
        await this.registerUser(user);
      }

      logger.info(`Successfully connected ${this.config.users.length} SIP users`);
      this.emit('connected');
    } catch (error) {
      logger.error('Failed to connect to SIP server:', error);
      this.emit('error', error);
      throw error;
    }
  }

  private async registerUser(user: SIPUser): Promise<void> {
    const uri = `sip:${user.username}@${this.config.server}`;
    const server = `sip:${this.config.server}:${this.config.port}`;

    const userAgent = new UserAgent({
      uri: UserAgent.makeURI(uri),
      transportOptions: {
        server: server
      },
      authorizationUsername: user.username,
      authorizationPassword: user.password,
      displayName: user.displayName || user.username,
      logLevel: 'warn',
      delegate: {
        onInvite: (invitation) => this.handleIncomingCall(invitation, user)
      }
    });

    // Start the user agent
    await userAgent.start();

    // Create and send REGISTER
    const registerer = new Registerer(userAgent);
    await registerer.register();

    this.userAgents.set(user.extension, userAgent);
    this.registerers.set(user.extension, registerer);

    logger.info(`SIP user registered: ${user.username} (${user.extension})`);
  }

  private handleIncomingCall(invitation: any, user: SIPUser): void {
    const callId = uuidv4();
    const from = invitation.remoteIdentity.uri.user;
    const to = user.extension;

    logger.info(`Incoming call: ${from} -> ${to}`);

    const call: Call = {
      id: callId,
      callId: invitation.request.callId,
      sessionId: invitation.id,
      direction: 'inbound',
      from: from,
      to: to,
      extension: user.extension,
      status: CallStatus.RINGING,
      startTime: new Date()
    };

    this.activeCalls.set(callId, call);
    this.activeSessions.set(callId, invitation);

    // Emit incoming call event
    this.emit('call:new', call);
    this.emit('call:ringing', call);

    // Setup session state change handler
    invitation.stateChange.addListener((state: SessionState) => {
      this.handleSessionStateChange(callId, state);
    });
  }

  private handleSessionStateChange(callId: string, state: SessionState): void {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    logger.info(`Call ${callId} state changed to: ${state}`);

    switch (state) {
      case SessionState.Established:
        call.status = CallStatus.ANSWERED;
        call.answerTime = new Date();
        this.emit('call:answered', call);
        break;

      case SessionState.Terminated:
        call.status = CallStatus.ENDED;
        call.endTime = new Date();
        if (call.answerTime) {
          call.duration = Math.floor((call.endTime.getTime() - call.answerTime.getTime()) / 1000);
        }
        this.emit('call:ended', call);
        this.activeCalls.delete(callId);
        this.activeSessions.delete(callId);
        break;
    }
  }

  async makeCall(from: string, to: string, autoAnswer: boolean = false): Promise<Call> {
    const userAgent = this.userAgents.get(from);
    if (!userAgent) {
      throw new Error(`No registered user agent for extension: ${from}`);
    }

    const target = UserAgent.makeURI(`sip:${to}@${this.config.server}`);
    if (!target) {
      throw new Error(`Invalid target URI: ${to}`);
    }

    const callId = uuidv4();
    const inviter = new Inviter(userAgent, target);

    const call: Call = {
      id: callId,
      callId: inviter.request.callId,
      sessionId: inviter.id,
      direction: 'outbound',
      from: from,
      to: to,
      extension: from,
      status: CallStatus.INITIATING,
      startTime: new Date()
    };

    this.activeCalls.set(callId, call);
    this.activeSessions.set(callId, inviter);

    // Setup state change handler
    inviter.stateChange.addListener((state: SessionState) => {
      this.handleSessionStateChange(callId, state);
    });

    // Send INVITE
    await inviter.invite();

    call.status = CallStatus.RINGING;
    this.emit('call:new', call);
    this.emit('call:ringing', call);

    logger.info(`Outbound call initiated: ${from} -> ${to}`);

    return call;
  }

  async answerCall(callId: string): Promise<void> {
    const session = this.activeSessions.get(callId);
    if (!session) {
      throw new Error(`No active session for call: ${callId}`);
    }

    // Accept the invitation
    if ('accept' in session) {
      await (session as any).accept();
      logger.info(`Call answered: ${callId}`);
    }
  }

  async hangupCall(callId: string): Promise<void> {
    const session = this.activeSessions.get(callId);
    if (!session) {
      throw new Error(`No active session for call: ${callId}`);
    }

    await session.dispose();
    logger.info(`Call hung up: ${callId}`);
  }

  async holdCall(callId: string): Promise<void> {
    const session = this.activeSessions.get(callId);
    const call = this.activeCalls.get(callId);

    if (!session || !call) {
      throw new Error(`No active call: ${callId}`);
    }

    // Send re-INVITE with hold SDP
    if ('hold' in session) {
      await (session as any).hold();
      call.status = CallStatus.HELD;
      this.emit('call:held', call);
      logger.info(`Call held: ${callId}`);
    }
  }

  async unholdCall(callId: string): Promise<void> {
    const session = this.activeSessions.get(callId);
    const call = this.activeCalls.get(callId);

    if (!session || !call) {
      throw new Error(`No active call: ${callId}`);
    }

    // Send re-INVITE with unhold SDP
    if ('unhold' in session) {
      await (session as any).unhold();
      call.status = CallStatus.ANSWERED;
      this.emit('call:resumed', call);
      logger.info(`Call resumed: ${callId}`);
    }
  }

  async transferCall(callId: string, target: string): Promise<void> {
    const session = this.activeSessions.get(callId);
    const call = this.activeCalls.get(callId);

    if (!session || !call) {
      throw new Error(`No active call: ${callId}`);
    }

    const targetUri = UserAgent.makeURI(`sip:${target}@${this.config.server}`);
    if (!targetUri) {
      throw new Error(`Invalid target URI: ${target}`);
    }

    // Send REFER
    if ('refer' in session) {
      await (session as any).refer(targetUri);
      call.status = CallStatus.TRANSFERRED;
      this.emit('call:transferred', call);
      logger.info(`Call transferred: ${callId} -> ${target}`);
    }
  }

  getActiveCalls(): Call[] {
    return Array.from(this.activeCalls.values());
  }

  getCallById(callId: string): Call | undefined {
    return this.activeCalls.get(callId);
  }

  isConnected(): boolean {
    return this.registerers.size > 0;
  }

  async disconnect(): Promise<void> {
    logger.info('Disconnecting SIP users...');

    // Hangup all active calls
    for (const [callId, session] of this.activeSessions.entries()) {
      try {
        await session.dispose();
      } catch (error) {
        logger.error(`Error hanging up call ${callId}:`, error);
      }
    }

    // Unregister all users
    for (const [extension, registerer] of this.registerers.entries()) {
      try {
        await registerer.unregister();
      } catch (error) {
        logger.error(`Error unregistering ${extension}:`, error);
      }
    }

    // Stop all user agents
    for (const [extension, userAgent] of this.userAgents.entries()) {
      try {
        await userAgent.stop();
      } catch (error) {
        logger.error(`Error stopping user agent ${extension}:`, error);
      }
    }

    this.userAgents.clear();
    this.registerers.clear();
    this.activeSessions.clear();
    this.activeCalls.clear();

    this.emit('disconnected');
    logger.info('Disconnected from SIP server');
  }
}
