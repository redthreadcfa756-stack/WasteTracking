import type { AppSettings, DaypartConfig, DaypartId, DonationItemConfig, ProductConfig } from './types';

export const DEFAULT_PRODUCTS: ProductConfig[] = [
  { id: 'grilled-breakfast', name: 'Grilled breakfast', menus: ['breakfast'], unitCost: 2.65, averageWeightLb: 0.35, tapQuantity: 1, trackingUnit: 'each', tone: 9 },
  { id: 'sausage', name: 'Sausage', menus: ['breakfast'], unitCost: 0.85, averageWeightLb: 0.1, tapQuantity: 1, trackingUnit: 'each', tone: 7 },
  { id: 'folded-yellow', name: 'Folded yellow', menus: ['breakfast'], unitCost: 0.55, averageWeightLb: 0.08, tapQuantity: 1, trackingUnit: 'each', tone: 6 },
  { id: 'folded-white', name: 'Folded white', menus: ['breakfast'], unitCost: 0.6, averageWeightLb: 0.08, tapQuantity: 1, trackingUnit: 'each', tone: 5 },
  { id: 'scrambled', name: 'Scrambled', menus: ['breakfast'], unitCost: 0.45, averageWeightLb: 0.07, tapQuantity: 1, trackingUnit: 'each', tone: 8 },
  { id: 'breakfast-filets', name: 'Breakfast filets', menus: ['breakfast'], unitCost: 1.85, averageWeightLb: 0.35, tapQuantity: 1, trackingUnit: 'each', tone: 6 },
  { id: 'breakfast-spicy', name: 'Breakfast spicy', menus: ['breakfast'], unitCost: 1.95, averageWeightLb: 0.35, tapQuantity: 1, trackingUnit: 'each', tone: 7 },
  { id: 'filets', name: 'Filets', menus: ['lunch'], unitCost: 2.35, averageWeightLb: 0.5, tapQuantity: 1, trackingUnit: 'each', tone: 1 },
  { id: 'spicy', name: 'Spicy filets', menus: ['lunch'], unitCost: 2.45, averageWeightLb: 0.5, tapQuantity: 1, trackingUnit: 'each', tone: 5 },
  { id: 'nuggets', name: 'Nuggets', menus: ['breakfast', 'lunch'], unitCost: 0.48, averageWeightLb: 0.04, tapQuantity: 14, trackingUnit: 'cup', unitsPerCup: 14, tone: 2 },
  { id: 'strips', name: 'Strips', menus: ['lunch'], unitCost: 1.18, averageWeightLb: 0.12, tapQuantity: 1, trackingUnit: 'each', tone: 8 },
  { id: 'grilled-nuggets', name: 'Grilled nuggets', menus: ['lunch'], unitCost: 0.62, averageWeightLb: 0.04, tapQuantity: 1, trackingUnit: 'each', tone: 3 },
  { id: 'grilled-filets', name: 'Grilled filets', menus: ['lunch'], unitCost: 3.1, averageWeightLb: 0.45, tapQuantity: 1, trackingUnit: 'each', tone: 4 },
];

export const PRODUCT_TONES = Object.fromEntries(
  DEFAULT_PRODUCTS.map((product) => [product.id, product.tone]),
) as Record<string, number>;

export const DEFAULT_DONATION_ITEMS: DonationItemConfig[] = [
  { id: 'full-strip-bacon', name: 'Full Strip Bacon', unit: 'lb', sourceProductIds: [] },
  { id: 'biscuits', name: 'Biscuits', unit: 'each', sourceProductIds: [] },
  { id: 'grilled-breakfast-donation', name: 'Grilled breakfast', unit: 'lb', sourceProductIds: ['grilled-breakfast'] },
  { id: 'grilled-filet-donation', name: 'Grilled filet', unit: 'lb', sourceProductIds: ['grilled-filets'] },
  { id: 'grilled-nuggets-donation', name: 'Grilled nuggets', unit: 'lb', sourceProductIds: ['grilled-nuggets'] },
  { id: 'spicy-filet-donation', name: 'Spicy filet', unit: 'lb', sourceProductIds: ['spicy'] },
  { id: 'spicy-breakfast-donation', name: 'Spicy Breakfast', unit: 'lb', sourceProductIds: ['breakfast-spicy'] },
  { id: 'breakfast-filet-donation', name: 'Breakfast filet', unit: 'lb', sourceProductIds: ['breakfast-filets'] },
  { id: 'filet-donation', name: 'Filet', unit: 'lb', sourceProductIds: ['filets'] },
  { id: 'nuggets-donation', name: 'Nuggets', unit: 'lb', sourceProductIds: ['nuggets'] },
  { id: 'strips-donation', name: 'Strips', unit: 'lb', sourceProductIds: ['strips'] },
  { id: 'yellow-total', name: 'Yellow Total', unit: 'lb', sourceProductIds: ['folded-yellow', 'scrambled'] },
  { id: 'english-muffins', name: 'English Muffins', unit: 'each', sourceProductIds: [] },
  { id: 'hashbrown', name: 'Hashbrown', unit: 'lb', sourceProductIds: [] },
  { id: 'mini-rolls', name: 'Mini Rolls', unit: 'each', sourceProductIds: [] },
  { id: 'sausage-donation', name: 'Sausage', unit: 'each', sourceProductIds: ['sausage'] },
  { id: 'tortillas', name: 'Tortillas', unit: 'each', sourceProductIds: [] },
  { id: 'mac-and-cheese', name: 'Mac & Cheese', unit: 'lb', sourceProductIds: [] },
  { id: 'noodle-soup', name: 'Noodle Soup', unit: 'lb', sourceProductIds: [] },
  { id: 'tortilla-soup', name: 'Tortilla Soup', unit: 'lb', sourceProductIds: [] },
];

const targets = (entries: Record<string, number>) => entries;

export const DEFAULT_DAYPARTS: DaypartConfig[] = [
  {
    id: 'breakfast', label: 'Breakfast', startMinutes: 390, endMinutes: 630, menu: 'breakfast', totalDollarTarget: 27.15,
    productTargetQuantities: targets({ 'grilled-breakfast': 3, sausage: 4, 'folded-yellow': 5, 'folded-white': 3, scrambled: 4, 'breakfast-filets': 3, 'breakfast-spicy': 2, nuggets: 0 }),
  },
  {
    id: 'lunch', label: 'Lunch', startMinutes: 630, endMinutes: 840, menu: 'lunch', totalDollarTarget: 50.95,
    productTargetQuantities: targets({ filets: 4, spicy: 3, nuggets: 4, strips: 2, 'grilled-nuggets': 3, 'grilled-filets': 1 }),
  },
  {
    id: 'afternoon', label: 'Afternoon', startMinutes: 840, endMinutes: 1020, menu: 'lunch', totalDollarTarget: 55,
    productTargetQuantities: targets({ filets: 3, spicy: 2, nuggets: 5, strips: 3, 'grilled-nuggets': 3, 'grilled-filets': 2 }),
  },
  {
    id: 'early-dinner', label: 'Early Dinner', startMinutes: 1020, endMinutes: 1140, menu: 'lunch', totalDollarTarget: 70,
    productTargetQuantities: targets({ filets: 4, spicy: 3, nuggets: 6, strips: 4, 'grilled-nuggets': 4, 'grilled-filets': 3 }),
  },
  {
    id: 'late-dinner', label: 'Late Dinner', startMinutes: 1140, endMinutes: 1320, menu: 'lunch', totalDollarTarget: 45,
    productTargetQuantities: targets({ filets: 2, spicy: 2, nuggets: 4, strips: 2, 'grilled-nuggets': 3, 'grilled-filets': 2 }),
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  warningCooldownSeconds: 90,
  cooldownTimersEnabled: false,
  sosEnabled: true,
  discardTrackingEnabled: false,
  cardScrubEnabled: true,
  products: DEFAULT_PRODUCTS,
  dayparts: DEFAULT_DAYPARTS,
  donationItems: DEFAULT_DONATION_ITEMS,
};

export const DAYPART_ORDER: DaypartId[] = ['breakfast', 'lunch', 'afternoon', 'early-dinner', 'late-dinner'];
