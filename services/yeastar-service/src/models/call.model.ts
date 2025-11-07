export interface YeastarCallEvent {
  event: string;
  callid: string;
  members: CallMember[];
  timestamp: number;
}

export interface CallMember {
  ext: {
    extid: string;
    number: string;
    channelid: string;
    memberstatus: string;
  };
  inbound?: {
    from: string;
    to: string;
    trunk: string;
  };
  outbound?: {
    from: string;
    to: string;
    trunk: string;
  };
}

export interface Call {
  id: string;
  callId: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  extension: string;
  status: 'ringing' | 'answered' | 'ended' | 'missed' | 'busy';
  startTime: Date;
  answerTime?: Date;
  endTime?: Date;
  duration?: number; // seconds
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
  orderId?: number;
  notes?: string;
  recording?: string;
  trunk?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CallLog {
  id: number;
  callId: string;
  direction: 'inbound' | 'outbound';
  callerNumber: string;
  calledNumber: string;
  extension: string;
  startTime: Date;
  answerTime?: Date;
  endTime?: Date;
  duration: number;
  status: string;
  customerId?: number;
  orderId?: number;
  recording?: string;
  createdAt: Date;
}

export interface Extension {
  id: number;
  number: string;
  name: string;
  email?: string;
  department?: string;
  status: 'online' | 'offline' | 'busy' | 'ringing';
  lastSeen?: Date;
  callsToday: number;
  avgCallDuration: number;
}

export interface ClickToCallRequest {
  from: string; // extension number
  to: string; // phone number to call
  autoAnswer?: boolean;
  callerIdName?: string;
}

export interface YeastarConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  apiVersion: string;
  reconnectInterval: number;
  heartbeatInterval: number;
}
