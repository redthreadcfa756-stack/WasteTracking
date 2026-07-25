import type { Timestamp } from 'firebase/firestore';

export type MenuId = 'breakfast' | 'lunch';
export type DaypartId = 'breakfast' | 'lunch' | 'afternoon' | 'early-dinner' | 'late-dinner';
export type DonationUnit = 'lb' | 'each';
export type MemberRole = 'employee' | 'admin';

export interface ProductConfig {
  id: string;
  name: string;
  menus: MenuId[];
  unitCost: number;
  averageWeightLb: number;
  tapQuantity: number;
  trackingUnit: 'each' | 'cup';
  unitsPerCup?: number;
  tone: number;
}

export interface DaypartConfig {
  id: DaypartId;
  label: string;
  startMinutes: number;
  endMinutes: number;
  menu: MenuId;
  totalDollarTarget: number;
  productTargetQuantities: Record<string, number>;
}

export interface DonationItemConfig {
  id: string;
  name: string;
  unit: DonationUnit;
  sourceProductIds: string[];
}

export interface AppSettings {
  version: number;
  warningCooldownSeconds: number;
  products: ProductConfig[];
  dayparts: DaypartConfig[];
  donationItems: DonationItemConfig[];
}

export interface MemberProfile {
  uid: string;
  storeId: string;
  displayName: string;
  role: MemberRole;
}

export interface WasteEvent {
  id: string;
  storeId: string;
  productId: string;
  productName: string;
  equivalentUnits: number;
  displayQuantity: number;
  displayUnit: 'each' | 'cup';
  unitCostSnapshot: number;
  eventAt: Timestamp | Date | null;
  dayKey: string;
  daypartId: DaypartId;
  menu: MenuId;
  deviceName: string;
  createdBy: string;
  createdByName: string;
}

export interface SosEntry {
  id: string;
  storeId: string;
  dayKey: string;
  daypartId?: DaypartId;
  hourStart?: number;
  averageSeconds: number;
  loggedAt: Timestamp | Date | null;
  createdBy: string;
  createdByName: string;
  deviceName: string;
}

export interface DonationRecord {
  storeId: string;
  dayKey: string;
  actuals: Record<string, number>;
  predictions: Record<string, number | null>;
  units: Record<string, DonationUnit>;
  variance: Record<string, number | null>;
  initials: string;
  submittedAt: Timestamp | Date | null;
  submittedBy: string;
  submittedByName: string;
  revision: number;
}

export interface MergedActivity {
  key: string;
  productId: string;
  productName: string;
  equivalentUnits: number;
  displayQuantity: number;
  displayUnit: 'each' | 'cup';
  cost: number;
  occurredAt: Date;
  deviceNames: string[];
  sourceEventIds: string[];
}
