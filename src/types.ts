import type { Timestamp } from 'firebase/firestore';

export type MenuId = 'breakfast' | 'lunch';
export type DaypartId = 'breakfast' | 'lunch' | 'afternoon' | 'early-dinner' | 'late-dinner';
export type DonationUnit = 'lb' | 'each';
export type WeightUnit = 'oz' | 'lb' | 'g';
export type MemberRole = 'employee' | 'admin';
export type CooldownPanId = 'pan-1' | 'pan-2' | 'pan-3' | 'pan-4';
export type DiscardReason = 'dropped' | 'raw' | 'overcooked' | 'contaminated' | 'quality' | 'other';

export interface ProductConfig {
  id: string;
  name: string;
  menus: MenuId[];
  unitCost: number;
  averageWeightLb: number;
  caseCost?: number;
  caseWeightLb?: number;
  perUnitWeight?: number;
  perUnitWeightUnit?: WeightUnit;
  tapQuantity: number;
  trackingUnit: 'each' | 'cup';
  unitsPerCup?: number;
  tone: number;
  discardOnly?: boolean;
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
  cooldownTimersEnabled: boolean;
  sosEnabled: boolean;
  discardTrackingEnabled: boolean;
  cardScrubEnabled: boolean;
  products: ProductConfig[];
  dayparts: DaypartConfig[];
  donationItems: DonationItemConfig[];
}

export interface CooldownTimer {
  id: CooldownPanId;
  storeId: string;
  panLabel: string;
  active: boolean;
  startedAt: Timestamp | Date | null;
  expiresAt: Timestamp | Date | null;
  lastWasteAt: Timestamp | Date | null;
  joinedWasteCount: number;
  joinedProductIds: string[];
  productQuantities: Record<string, number>;
  startedBy: string;
  startedByName: string;
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

export interface DiscardEvent extends WasteEvent {
  reason: DiscardReason;
  reasonDetail: string;
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
