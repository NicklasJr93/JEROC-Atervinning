export type Category = {
  id: string;
  name: string;
  description: string;
  photo: number;
};
export type Article = {
  id: string;
  active?: boolean;
  category: string;
  name: string;
  description: string;
  includes: string;
  excludes: string;
  photos: number[];
  prices: [number, number, number];
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
export const articles: Article[] = [
  {
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
  references: string[];
  origins: string[];
  registrations?: string[];
};
// Synthetic format-only identity for local demos; never verified or sent to NVV.
export const demoPrivateIdentityNumber = '19900101-0000';
export const initialCustomers: Customer[] = [
  {
    id: 'customer-build',
    registrations: ['ABC123'],
    name: 'Bygg & Riv AB',
    type: 'Företag',
    number: '559123-7890',
    phone: '070-000 12 34',
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
    number: '559234-5678',
    phone: '070-000 23 45',
    email: 'info@andersson.example',
    references: ['Lagerbyggnad'],
    origins: ['Stationsvägen 4, 762 51 Rimbo'],
  },
  {
    id: 'customer-brf',
    name: 'BRF Solbacken',
    type: 'BRF',
    number: '769999-1234',
    phone: '070-000 34 56',
    email: 'styrelsen@solbacken.example',
    references: ['Byte av värmesystem'],
    origins: ['Solvägen 12, 761 41 Norrtälje'],
  },
  {
    id: 'customer-erik',
    name: 'Erik Johansson',
    type: 'Privatperson',
    number: demoPrivateIdentityNumber,
    phone: '070-000 45 67',
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
let sharedCustomerPrices: Record<string,Record<string,{price:number;source:string}>> | undefined;
export function updateCustomerPriceCatalog(prices: typeof sharedCustomerPrices) { sharedCustomerPrices=prices; }
export function demoCustomerPrice(customerId: string, article: Article) {
  if(sharedCustomerPrices)return sharedCustomerPrices[customerId]?.[article.id]??{price:article.prices[2],source:"C"};
  const example = demoCustomerPrices[customerId]?.[article.id];
  const tier = example?.tier ?? 2;
  return {
    price: example?.special ?? article.prices[tier],
    source: example?.special != null ? 'Specialpris' : ['A', 'B', 'C'][tier],
  };
}

/** Refresh the existing material views from the shared server register. */
export function updateArticleCatalog(values: Article[]) {
  articles.splice(0,articles.length,...values);
}
