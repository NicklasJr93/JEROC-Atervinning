import type { ArticleTaxCategory } from './office/pricing-client';
import { z } from 'zod';
import type { ArticleGroup, ArticleImage } from './catalog-types';
import { activeArticleGroups } from './catalog-types';
import { BUILT_IN_ARTICLE_IMAGE_COUNT } from './catalog-images';

export type Category = {
  id: string;
  name: string;
  description: string;
  photo: number;
};
export type Article = {
  id: string;
  active?: boolean;
  taxCategory?: ArticleTaxCategory;
  category: string;
  name: string;
  description: string;
  includes: string;
  excludes: string;
  photos: ArticleImage[];
  prices: [number | null, number | null, number | null];
};
export const categories: Category[] = [
  {
    id: 'aluminium',
    name: 'Aluminium',
    description: 'Profiler, plåt och gjutgods',
    photo: 8,
  },
  { id: 'bly', name: 'Bly', description: 'Block, plåt och vikter', photo: 20 },
  { id: 'batterier', name: 'Batterier', description: 'Blybatterier · separat hantering', photo: 20 },
  { id: 'jarn', name: 'Järn', description: 'Järnskrot och stål', photo: 4 },
  { id: 'kabel', name: 'Kabel', description: 'Isolerad kabel', photo: 24 },
  {
    id: 'koppar',
    name: 'Koppar',
    description: 'Rör, tråd och blandad koppar',
    photo: 0,
  },
  {
    id: 'massing',
    name: 'Mässing',
    description: 'Rör, ventiler och detaljer',
    photo: 12,
  },
  {
    id: 'rostfritt',
    name: 'Rostfritt',
    description: 'Rör, plåt och blandat',
    photo: 16,
  },
];
/** Keep the fixed seed export for migrations; the app reads the live register. */
export const articleGroups: ArticleGroup[] = categories.map((category, sortOrder) => ({
  ...category, sortOrder, active: true, revision: 1,
}));
export const UNGROUPED_ARTICLE_GROUP_ID = '__ungrouped__';

export function selectableArticles(): Article[] {
  const visible = new Set(activeArticleGroups(articleGroups).map(group => group.id));
  const known = new Set(articleGroups.map(group => group.id));
  return articles.filter(article => article.active !== false && (!known.has(article.category) || visible.has(article.category)));
}

export function materialGroupId(article: Article): string {
  return articleGroups.some(group => group.id === article.category) ? article.category : UNGROUPED_ARTICLE_GROUP_ID;
}
export const articles: Article[] = [
  {
    taxCategory: 'scrap_reverse',
    id: 'copper-1',
    category: 'koppar',
    name: 'Koppar klass 1',
    description: 'Blank, ren, utan föroreningar',
    includes: 'Ren koppartråd, rena kopparrör och rena kopparskenor.',
    excludes: 'Isolerad kabel, förtent koppar, järn och andra föroreningar.',
    photos: [0, 1, 2, 3],
    prices: [82, 73.8, 65.6],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'copper-2',
    category: 'koppar',
    name: 'Koppar klass 2',
    description: 'Ren koppar med ytoxid',
    includes: 'Oisolerade kopparrör och koppartråd med mörkare yta.',
    excludes: 'Isolerad kabel, järn och plast.',
    photos: [28, 29, 30, 31],
    prices: [77, 69.3, 61.6],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'copper-tin',
    category: 'koppar',
    name: 'Förtent koppar',
    description: 'Koppar med förtenning',
    includes: 'Förtent koppartråd och kopparkomponenter.',
    excludes: 'Isolerad kabel och blandat järnskrot.',
    photos: [32, 33, 34, 35],
    prices: [68, 61.2, 54.4],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'copper-mixed',
    category: 'koppar',
    name: 'Blandad koppar',
    description: 'Blandade kopparformer',
    includes: 'Kopparrör, tråd och delar av koppar.',
    excludes: 'Plast, isolerad kabel och järn.',
    photos: [36, 37, 38, 39],
    prices: [70, 63, 56],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'iron',
    category: 'jarn',
    name: 'Järnskrot',
    description: 'Blandat järn och stål',
    includes: 'Järn, stål, balkar och rena metallkonstruktioner.',
    excludes: 'Betong, sopor, slutna behållare och andra metaller.',
    photos: [4, 5, 6, 7],
    prices: [2.4, 2.16, 1.92],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'steel',
    category: 'jarn',
    name: 'Balk / stål',
    description: 'Balkar och konstruktionsstål',
    includes: 'Stålbalkar och rena stålkonstruktioner.',
    excludes: 'Betong, plast och andra metaller.',
    photos: [6, 5, 4, 7],
    prices: [2.8, 2.52, 2.24],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'aluminium',
    category: 'aluminium',
    name: 'Aluminium',
    description: 'Rena profiler och plåt',
    includes: 'Rena aluminiumprofiler och aluminiumplåt.',
    excludes: 'Järn, plast och blandade material.',
    photos: [8, 9, 10, 11],
    prices: [18, 16.2, 14.4],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'aluminium-cast',
    category: 'aluminium',
    name: 'Aluminium gjutgods',
    description: 'Rena gjutna delar',
    includes: 'Rena gjutna aluminiumdelar.',
    excludes: 'Fastmonterat järn, olja och plast.',
    photos: [10, 8, 11, 9],
    prices: [15, 13.5, 12],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'lead',
    category: 'bly',
    name: 'Bly',
    description: 'Blyplåt, block och vikter',
    includes: 'Blyplåt, blyblock och blyvikter.',
    excludes: 'Batterier och andra metaller.',
    photos: [20, 21, 22, 23],
    prices: [12, 10.8, 9.6],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'lead-battery',
    category: 'batterier',
    name: 'Blybatterier',
    description: 'Förbrukade blybatterier · farligt avfall',
    includes: 'Blybatterier från fordon och verkstäder. Hanteras separat enligt anläggningens instruktioner.',
    excludes: 'Litiumbatterier, andra batterityper och lösa blydelar.',
    photos: [],
    prices: [4, 3.6, 3.2],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'cable',
    category: 'kabel',
    name: 'Blandkabel',
    description: 'Isolerad kopparkabel',
    includes: 'Elektrisk kabel med kopparledare och isolering.',
    excludes: 'Optisk fiber, slang och kabel med olja.',
    photos: [24, 25, 26, 27],
    prices: [23, 20.7, 18.4],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'cable-thick',
    category: 'kabel',
    name: 'Kraftkabel',
    description: 'Grov isolerad kopparkabel',
    includes: 'Grov kraftkabel med kopparledare.',
    excludes: 'Aluminiumkabel, fiber och oljekabel.',
    photos: [25, 27, 26, 24],
    prices: [32, 28.8, 25.6],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'brass',
    category: 'massing',
    name: 'Mässing',
    description: 'Rördelar, ventiler och blandat',
    includes: 'Mässingskopplingar, ventiler och detaljer.',
    excludes: 'Järn, plast och kompletta blandade armaturer.',
    photos: [12, 13, 14, 15],
    prices: [42, 37.8, 33.6],
  },
  {
    taxCategory: 'scrap_reverse',
    id: 'stainless',
    category: 'rostfritt',
    name: 'Rostfritt',
    description: 'Rent, omagnetiskt rostfritt',
    includes: 'Rena rostfria rör, plåt och detaljer.',
    excludes: 'Vanligt järn, plast och blandade material.',
    photos: [16, 17, 18, 19],
    prices: [13, 11.7, 10.4],
  },
];
export function articleById(id: string) {
  return articles.find((a) => a.id === id)!;
}
export type Customer = {
  id: string;
  name: string;
  type: 'Företag' | 'Privatperson' | 'BRF';
  number: string;
  phone: string;
  email: string;
  address?: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
  vatRegistered?: boolean;
  paymentTermDays?: number;
  paymentProfile?: import('./payment-details').PaymentDetails;
  references: string[];
  origins: string[];
  registrations?: string[];
};
// Synthetic, checksum-valid fixtures for NEW local demos. A checksum is not a
// registry verification; existing customers and frozen proofs are never reset.
export const demoPrivateIdentityNumber = '199001010009';
export const initialCustomers: Customer[] = [
  {
    id: 'customer-build',
    registrations: ['ABC123'],
    name: 'Bygg & Riv AB',
    type: 'Företag',
    number: '5591237895',
    phone: '+46700001234',
    email: 'kontakt@byggriv.example',
    references: ['Projekt Solbacken', 'Renovering Centrum'],
    origins: [
      'Ängsvägen 19, 123 45 Stockholm',
      'Industrivägen 8, 761 41 Norrtälje',
    ],
  },
  {
    id: 'customer-andersson',
    name: 'Anderssons Entreprenad',
    type: 'Företag',
    number: '5592345671',
    phone: '+46700002345',
    email: 'info@andersson.example',
    references: ['Lagerbyggnad'],
    origins: ['Stationsvägen 4, 762 51 Rimbo'],
  },
  {
    id: 'customer-brf',
    name: 'BRF Solbacken',
    type: 'BRF',
    number: '7699991233',
    phone: '+46700003456',
    email: 'styrelsen@solbacken.example',
    references: ['Byte av värmesystem'],
    origins: ['Solvägen 12, 761 41 Norrtälje'],
  },
  {
    id: 'customer-erik',
    name: 'Erik Johansson',
    type: 'Privatperson',
    number: demoPrivateIdentityNumber,
    phone: '+46700004567',
    email: '',
    references: [],
    origins: [],
  },
];

// Fictional customer price examples for the mobile demo, per article.
// The office pricing engine and rolling volume rules are not connected yet.
export const demoCustomerPrices: Record<
  string,
  Record<string, { tier: 0 | 1 | 2; special?: number }>
> = {
  'customer-build': { 'copper-1': { tier: 0, special: 84 }, iron: { tier: 0 } },
  'customer-erik': { 'copper-1': { tier: 1 } },
};
export type MobileCustomerPrices = Record<string,Record<string,{price:number | null;source:string}>>;
let sharedCustomerPrices: MobileCustomerPrices | undefined;
export function updateCustomerPriceCatalog(prices: MobileCustomerPrices | undefined) { sharedCustomerPrices=prices; }
export function mergeCustomerPriceCatalog(prices: unknown): MobileCustomerPrices | undefined {
  const parsed = z.record(z.record(z.object({ price: z.number().finite().nullable(), source: z.string().max(100) }))).safeParse(prices);
  if (!parsed.success) return undefined;
  sharedCustomerPrices = { ...sharedCustomerPrices, ...parsed.data };
  return structuredClone(sharedCustomerPrices);
}
export function demoCustomerPrice(customerId: string, article: Article) {
  if(sharedCustomerPrices)return sharedCustomerPrices[customerId]?.[article.id]??{price:null,source:"Pris saknas"};
  const example = demoCustomerPrices[customerId]?.[article.id];
  const tier = example?.tier ?? 2;
  return {
    price: example?.special ?? article.prices[tier],
    source: example?.special != null ? 'Specialpris' : ['A', 'B', 'C'][tier],
  };
}

const imageReferenceSchema = z.union([z.number().int().min(0).max(BUILT_IN_ARTICLE_IMAGE_COUNT - 1), z.string().uuid()]);
const mobileArticleSchema = z.object({
  id: z.string().min(1), active: z.boolean().optional(), category: z.string(),
  name: z.string(), description: z.string(), includes: z.string(), excludes: z.string(),
  photos: z.array(imageReferenceSchema).max(6),
  prices: z.tuple([z.number().finite().nullable(), z.number().finite().nullable(), z.number().finite().nullable()]),
  taxCategory: z.enum(['scrap_reverse', 'standard_25', 'no_vat', 'review']).optional(),
});
const mobileGroupsSchema = z.array(z.object({
  id: z.string().min(1), name: z.string(), description: z.string(),
  photo: imageReferenceSchema.nullable(), parentId: z.string().min(1).optional(),
  sortOrder: z.number().int(), active: z.boolean(), revision: z.number().int().positive(),
}));

/** Apply a validated register as a unit, including authoritative empty groups. */
export function updateArticleCatalog(values: unknown, groups?: unknown): boolean {
  const parsed = z.array(mobileArticleSchema).safeParse(values);
  const parsedGroups = groups === undefined ? undefined : mobileGroupsSchema.safeParse(groups);
  if (!parsed.success || (parsedGroups && !parsedGroups.success)) return false;
  if (new Set(parsed.data.map(article => article.id)).size !== parsed.data.length) return false;
  if (parsedGroups?.success && new Set(parsedGroups.data.map(group => group.id)).size !== parsedGroups.data.length) return false;
  articles.splice(0, articles.length, ...parsed.data);
  if (parsedGroups?.success) articleGroups.splice(0, articleGroups.length, ...parsedGroups.data);
  return true;
}
