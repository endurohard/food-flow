// Type declarations for sip.js
declare module 'sip.js' {
  export enum SessionState {
    Initial = 'Initial',
    Establishing = 'Establishing',
    Established = 'Established',
    Terminating = 'Terminating',
    Terminated = 'Terminated'
  }

  export interface URI {
    user: string;
    host: string;
    port?: number;
  }

  export interface RemoteIdentity {
    uri: URI;
    displayName?: string;
  }

  export interface InvitationOptions {
    accept?: () => Promise<void>;
  }

  export interface Invitation {
    id: string;
    request: {
      callId: string;
    };
    remoteIdentity: RemoteIdentity;
    stateChange: {
      addListener: (listener: (state: SessionState) => void) => void;
    };
    accept?: () => Promise<void>;
  }

  export class Session {
    id: string;
    dispose(): Promise<void>;
  }

  export class Inviter extends Session {
    request: {
      callId: string;
    };
    invite(): Promise<void>;
  }

  export class Registerer {
    constructor(userAgent: UserAgent);
    register(): Promise<void>;
    unregister(): Promise<void>;
  }

  export interface UserAgentOptions {
    uri: URI;
    transportOptions: {
      server: string;
    };
    authorizationUsername: string;
    authorizationPassword: string;
    displayName?: string;
    logLevel?: string;
    delegate?: {
      onInvite?: (invitation: Invitation) => void;
    };
  }

  export class UserAgent {
    constructor(options: UserAgentOptions);
    static makeURI(uri: string): URI | undefined;
    start(): Promise<void>;
    stop(): Promise<void>;
  }

  export namespace Web {
    export class Transport {}
  }

  export class Transport {}
}
