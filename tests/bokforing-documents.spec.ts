import { test, expect, type Page } from '@playwright/test';

// These tests exercise real browser IndexedDB; no mocked persistence package is
// involved. Each Playwright context has its own local document inbox.
async function ready(page: Page) {
  await page.goto('/bokforing/klassisk.html');
  await page.evaluate(async () => {
    const path = '/bokforing/suite/documents.js';
    const module = await import(path);
    (window as any).documentModule = module;
    (window as any).documentStore = module.createDocumentStore();
  });
}

test('lokala originalfiler och metadata kan läsas efter återöppnad underlagslagring', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const store = (window as any).documentStore;
    const data = [
      new File(['%PDF-1.7\nDemo PDF'], 'faktura.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])], 'foto.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2])], 'bild.png', { type: 'image/png' }),
      new File(['RIFF1234WEBPdemo'], 'scan.webp', { type: 'image/webp' }),
    ];
    const uploaded = await store.importFiles(data, { source: 'camera' });
    await store.close();
    const reopened = (window as any).documentModule.createDocumentStore();
    const listed = await reopened.list();
    const verified = await reopened.verifyDocuments(uploaded);
    const pdf = await reopened.get(uploaded[0].id);
    return { uploaded, listed, verified, pdf: await pdf.blob.text(), keys: Object.keys(uploaded[0]) };
  });
  expect(result.uploaded).toHaveLength(4);
  expect(result.listed).toHaveLength(4);
  expect(result.verified).toEqual(result.uploaded);
  expect(result.uploaded.every((item: any) => item.source === 'camera' && /^doc-[a-f0-9]{64}$/.test(item.id))).toBe(true);
  expect(result.keys).toEqual(['id', 'name', 'type', 'size', 'sha256', 'createdAt', 'source']);
  expect(result.pdf).toBe('%PDF-1.7\nDemo PDF');
});

test('identiska bytes återanvänds även med nytt filnamn och samtidiga importer', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const module = (window as any).documentModule, first = (window as any).documentStore;
    const file = new File(['%PDF-1.7\nSamma original'], 'original.pdf', { type: 'application/pdf' });
    const renamed = new File([file], 'ett-annat-namn.pdf', { type: 'application/pdf' });
    const second = module.createDocumentStore();
    const [a, b] = await Promise.all([first.importFiles([file, renamed]), second.importFiles([renamed])]);
    return { a, b, listed: await first.list() };
  });
  expect(result.listed).toHaveLength(1);
  expect(result.a).toHaveLength(1);
  expect(result.b).toEqual(result.a);
});

test('falska filtyper och ogiltig batch lämnar inkorgen oförändrad', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const store = (window as any).documentStore, errors: string[] = [];
    const good = new File(['%PDF-1.7\nRätt'], 'giltig.pdf', { type: 'application/pdf' });
    const invalid = [
      new File(['<script>alert(1)</script>'], 'falsk.pdf', { type: 'application/pdf' }),
      new File(['%PDF-1.7\nFel extension'], 'falsk.png', { type: 'image/png' }),
      new File(['%PDF-1.7\nFel MIME'], 'mime.pdf', { type: 'image/png' }),
      new File(['<svg/>'], 'bild.svg', { type: 'image/svg+xml' }),
      new File([], 'tom.pdf', { type: 'application/pdf' }),
    ];
    for (const file of invalid) {
      try { await store.importFiles([good, file]); errors.push('ACCEPTED'); } catch (error) { errors.push((error as Error).message); }
    }
    return { errors, listed: await store.list() };
  });
  expect(result.errors).toHaveLength(5);
  expect(result.errors).not.toContain('ACCEPTED');
  expect(result.listed).toEqual([]);
});

test('storleksgräns och högst tio filer kontrolleras innan någon skrivning', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const store = (window as any).documentStore, errors: string[] = [];
    const tiny = new File(['%PDF-1.7\nDemo'], 'liten.pdf', { type: 'application/pdf' });
    const tooBig = { name: 'stor.pdf', type: 'application/pdf', size: 15 * 1024 * 1024 + 1,
      arrayBuffer() { throw new Error('Filen ska nekas före läsning'); } };
    for (const files of [[], [tooBig], Array(11).fill(tiny)]) {
      try { await store.importFiles(files); errors.push('ACCEPTED'); } catch (error) { errors.push((error as Error).message); }
    }
    return { errors, listed: await store.list() };
  });
  expect(result.errors[0]).toContain('minst en');
  expect(result.errors[1]).toContain('15 MB');
  expect(result.errors[2]).toContain('10 underlag');
  expect(result.listed).toEqual([]);
});

test('avbruten IDB-skrivning rullar tillbaka hela batchen och ger ingen lyckad kvittens', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const store = (window as any).documentStore;
    // Open the real database before temporarily failing the second add call.
    await store.list();
    const original = IDBObjectStore.prototype.add;
    let writes = 0, message = '', succeeded = false;
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
      writes++;
      if (writes === 2) throw new DOMException('Simulerat fullt utrymme', 'QuotaExceededError');
      return original.apply(this, args);
    };
    try {
      await store.importFiles([
        new File(['%PDF-1.7\nEtt'], 'ett.pdf', { type: 'application/pdf' }),
        new File(['%PDF-1.7\nTvå'], 'tva.pdf', { type: 'application/pdf' }),
      ]);
      succeeded = true;
    } catch (error) { message = (error as Error).message; }
    finally { IDBObjectStore.prototype.add = original; }
    return { message, succeeded, writes, listed: await store.list() };
  });
  expect(result.writes).toBe(2);
  expect(result.succeeded).toBe(false);
  expect(result.message).toContain('lagringsutrymme är fullt');
  expect(result.listed).toEqual([]);
});

test('hundra MB-gränsen räknar originalfiler och nekar hela den överskridande batchen', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const store = (window as any).documentStore;
    const body = new Uint8Array(15 * 1024 * 1024);
    body.set(new TextEncoder().encode('%PDF-1.7\n'));
    const makeFile = (marker: number) => {
      body[body.length - 1] = marker;
      return new File([body], `underlag-${marker}.pdf`, { type: 'application/pdf' });
    };
    await store.importFiles([1, 2, 3, 4, 5].map(makeFile));
    let message = '';
    try { await store.importFiles([6, 7].map(makeFile)); } catch (error) { message = (error as Error).message; }
    const listed = await store.list();
    return { message, count: listed.length, bytes: listed.reduce((sum: number, document: any) => sum + document.size, 0) };
  });
  expect(result.message).toContain('100 MB');
  expect(result.count).toBe(5);
  expect(result.bytes).toBe(75 * 1024 * 1024);
});

test('filkontrollen nekar ändrade dokumentuppgifter och en borttagen originalfil', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const store = (window as any).documentStore;
    const [metadata] = await store.importFiles([new File(['%PDF-1.7\nOriginal'], 'original.pdf', { type: 'application/pdf' })]);
    const errors: string[] = [];
    try { await store.verifyDocuments([{ ...metadata, name: 'ändrat.pdf' }]); } catch (error) { errors.push((error as Error).message); }
    await store.remove(metadata.id);
    try { await store.verifyDocuments([metadata]); } catch (error) { errors.push((error as Error).message); }
    return { errors, missing: await store.get(metadata.id) };
  });
  expect(result.errors[0]).toContain('stämmer inte');
  expect(result.errors[1]).toContain('saknas');
  expect(result.missing).toBeNull();
});

test('ändrade originalbytes stoppas av SHA256-kontrollen trots samma filstorlek', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const store = (window as any).documentStore;
    const [metadata] = await store.importFiles([new File(['%PDF-1.7\nOriginal'], 'original.pdf', { type: 'application/pdf' })]);
    await store.close();
    const request = indexedDB.open((window as any).documentModule.DOCUMENT_DB_NAME, 1);
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('documents', 'readwrite'), objectStore = tx.objectStore('documents');
        const read = objectStore.get(metadata.id);
        read.onsuccess = () => objectStore.put({ ...read.result, blob: new Blob(['%PDF-1.7\nErsatt!!'], { type: 'application/pdf' }) });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    try { await store.verifyDocuments([metadata]); return 'ACCEPTED'; } catch (error) { return (error as Error).message; }
  });
  expect(result).not.toBe('ACCEPTED');
  expect(result).toContain('klarade inte filkontrollen');
});

test('saknat IndexedDB-stöd ger ett tydligt fel i stället för låtsad lagring', async ({ page }) => {
  await ready(page);
  const message = await page.evaluate(async () => {
    const store = (window as any).documentModule.createDocumentStore({ indexedDB: null });
    try { await store.importFiles([new File(['%PDF-1.7\nDemo'], 'demo.pdf', { type: 'application/pdf' })]); return 'ACCEPTED'; }
    catch (error) { return (error as Error).message; }
  });
  expect(message).toContain('saknar stöd för lokal underlagslagring');
});
