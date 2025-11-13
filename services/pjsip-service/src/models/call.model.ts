export interface SIPConfig {
  server: string;
  port: number;
  transport: 'UDP' | 'TCP' | 'TLS' | 'WS' | 'WSS';
  users: SIPUser[];
  rtpPortMin: number;
  rtpPortMax: number;
  websocketUrl?: string;
  useWebSocket?: boolean;
}

export interface SIPUser {
  username: string;
  password: string;
  extension: string;
  displayName?: string;
  wsPassword?: string; // WebSocket password (may differ from SIP password)
}

export interface Call {
  id: string;
  callId: string;
  sessionId: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  extension?: string;
  status: CallStatus;
  startTime: Date;
  answerTime?: Date;
  endTime?: Date;
  duration?: number;
  recording?: string;
  customerId?: string;
  customerName?: string;
  orderId?: string;
  notes?: string;
}

export enum CallStatus {
  INITIATING = 'initiating',
  RINGING = 'ringing',
  ANSWERED = 'answered',
  HELD = 'held',
  TRANSFERRED = 'transferred',
  ENDED = 'ended',
  FAILED = 'failed',
  BUSY = 'busy',
  NO_ANSWER = 'no_answer',
  CANCELLED = 'cancelled'
}

export interface CallEvent {
  type: 'new' | 'ringing' | 'answered' | 'ended' | 'failed' | 'held' | 'transferred';
  call: Call;
  timestamp: Date;
}

export interface CallStats {
  extension: string;
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  answeredCalls: number;
  missedCalls: number;
  averageDuration: number;
  totalDuration: number;
}
