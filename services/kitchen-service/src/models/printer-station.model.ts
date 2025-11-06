export interface PrinterStation {
  id: number;
  name: string;
  type: 'network' | 'usb' | 'bluetooth';
  address?: string; // For network: IP:PORT
  device?: string; // For USB: /dev/usb/lp0
  bluetooth?: string; // For Bluetooth: MAC address
  categories: string[]; // Categories to print (pizza, burger, hot, cold, etc.)
  copies: number; // Number of copies to print
  enabled: boolean;
  status: 'online' | 'offline' | 'testing';
  lastPrint?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PrinterSettings {
  autoPrint: boolean;
  defaultCopies: number;
  fontSize: number;
  paperWidth: 58 | 80;
  encoding: 'UTF8' | 'SLOVENIA' | 'CP866';
  printLogo: boolean;
}
