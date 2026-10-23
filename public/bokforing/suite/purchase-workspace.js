// Coordinates the local document inbox and supplier-invoice pages.
// Files stay in IndexedDB; only immutable file metadata enters the demo book.
import { assert } from './core.js';
import * as Purchases from './operations.js';
import { createDocumentStore } from './documents.js';
import { escapeHtml as e } from './views.js';
import {
  createPurchaseEditorDraft, renderPurchaseList, renderPurchaseEditor,
  readPurchaseEditor, renderPurchaseSummary, renderPurchaseDetail,
  renderDocumentInbox, renderDocumentPanel, renderDocumentViewer, renderDocumentPicker, applyPurchaseVatMode, changePurchaseLines, defaultPurchaseDate,
} from './purchase-page.js';

const actions = new Set(['new-bill','show-bill','edit-bill','copy-bill','purchase-back',
  'open-document-inbox','open-document-picker','attach-document','unlink-document',
  'select-document','select-inbox-document','download-document','remove-inbox-document',
  'create-bill-from-document','link-document-existing','reload-documents',
  'document-zoom-in','document-zoom-out','document-rotate','document-reset','book-bill',
  'purchase-inbox','close-document-picker','close-inbox-preview','purchase-add-line','purchase-remove-line']);
const forms = new Set(['purchase-page','document-picker','link-document','purchase-book']);
const path = (id, edit=false) => '#purchases/'+encodeURIComponent(id)+(edit?'/edit':'');

export function createPurchaseWorkspace({ getState, readStoredState, write, toast, canWrite, navigate, openDialog, closeDialog, rerender }) {
  const store = createDocumentStore();
  let current = null, draft = null, draftKey = '', dirty = false;
  let documents = [], loaded = false, documentError = '', loading = null;
  let selectedId = null, objectUrl = null, viewerToken = 0, generation = 0, mutationGeneration = 0, zoom = 1, rotation = 0, importing = false;
  const findBill = id => getState().bills.find(bill => bill.id === id);
  const billFiles = bill => Purchases.getBillAttachments(bill);
  const editor = () => document.querySelector('#purchase-page-form');
  const linkedBills = id => getState().bills.filter(bill => billFiles(bill).some(file => file.id === id));
  const requireWritable = () => assert(canWrite(), 'Sparandet är pausat. Läs in senaste demodata innan du fortsätter.');
  const lock = task => navigator.locks?.request
    ? navigator.locks.request('scrapplanner-bokforing-document-links', task)
    : Promise.reject(new Error('Säker samordning av underlag kräver en uppdaterad webbläsare och HTTPS.'));
  function discard(invalidateWrites=false) {
    generation += 1;
    if(invalidateWrites)mutationGeneration += 1;
    draft = null; draftKey = ''; dirty = false; selectedId = null;
    viewerToken += 1;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  async function loadDocuments(force=false) {
    if (loaded && !force) return documents;
    if (loading) return loading;
    loading = store.list().then(items => {
      documents = items; loaded = true; documentError = ''; return items;
    }).catch(error => {
      documentError = error.message; loaded = true; throw error;
    }).finally(() => { loading = null; });
    return loading;
  }
  function editorAttachments() {
    const form = editor();
    return form ? JSON.parse(form.dataset.attachments || '[]') : draft?.attachments || [];
  }
  function visibleFiles() {
    if (current?.mode === 'inbox') return documents;
    if (['new','edit','copy'].includes(current?.mode)) return editorAttachments();
    const bill = findBill(current?.id);
    return bill ? billFiles(bill) : [];
  }
  function setAttachments(items) {
    assert(items.length <= 20, 'Högst 20 underlag kan kopplas till samma faktura.');
    draft = { ...draft, attachments: items };
    const form = editor();
    if (form) form.dataset.attachments = JSON.stringify(items);
    dirty = true;
    refreshPanel();
    updateSummary();
  }
  function updateSummary() {
    const form = editor();
    if (!form) return;
    const summary = document.querySelector('#purchase-live-summary');
    try {
      draft = readPurchaseEditor(form);
      if (summary) summary.innerHTML = renderPurchaseSummary(draft);
    } catch (error) {
      if (summary) summary.innerHTML = `<p class="form-help">${e(error.message)}</p>`;
    }
    const status = document.querySelector('#purchase-editor-status');
    if (status) status.textContent = dirty ? 'Osparade ändringar' : 'Utkast';
  }
  function refreshPanel() {
    const panel = document.querySelector('#purchase-document-panel');
    if (!panel) return;
    const items = visibleFiles();
    if (!items.some(file => file.id === selectedId)) selectedId = items[0]?.id || null;
    const editable=!!editor(), bill=findBill(current?.id);
    panel.outerHTML = renderDocumentPanel(items, {
      editable, canAppend: !editable&&!!bill&&bill.status!=='draft', selectedDocumentId: selectedId,
    });
    void refreshViewer();
  }
  async function refreshViewer() {
    const target = document.querySelector('#purchase-document-viewer');
    if (!target) return;
    const token = ++viewerToken;
    const items = visibleFiles();
    if (!items.some(file => file.id === selectedId)) selectedId = items[0]?.id || null;
    const metadata = items.find(file => file.id === selectedId);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    if (!metadata) { target.innerHTML = renderDocumentViewer(null, { error: documentError }); return; }
    target.innerHTML = renderDocumentViewer(metadata, { loading: true });
    try {
      const record = await store.get(metadata.id);
      if (token !== viewerToken || !target.isConnected) return;
      assert(record?.blob, 'Originalfilen saknas i den här webbläsaren. Underlagskontrollen kan inte slutföras.');
      objectUrl = URL.createObjectURL(record.blob);
      target.innerHTML = renderDocumentViewer(metadata, { url: objectUrl, zoom, rotation });
    } catch (error) {
      if (token === viewerToken && target.isConnected) target.innerHTML = renderDocumentViewer(metadata, { error: error.message });
    }
  }
  function render(ui) {
    current = { mode: ui.purchaseMode || 'list', id: ui.billId, sourceId: ui.purchaseSourceId, key: ui.purchaseRouteKey };
    const state = getState();
    if (current.mode === 'list') return renderPurchaseList(state, ui.search);
    if (current.mode === 'inbox') return renderDocumentInbox(documents, state, { loading: !loaded, error: documentError, selectedDocumentId:selectedId });
    if (current.mode === 'detail') {
      const bill = findBill(current.id);
      assert(bill, 'Leverantörsfakturan finns inte. Gå tillbaka till fakturalistan.');
      return renderPurchaseDetail(state, bill, { documents, selectedDocumentId: selectedId });
    }
    if (draftKey !== current.key) {
      let source = current.mode === 'edit' ? findBill(current.id) : null;
      if (current.mode === 'edit') assert(source?.status === 'draft', 'Bara fakturautkast kan redigeras.');
      if (current.mode === 'copy') {
        const original = findBill(current.sourceId);
        assert(original, 'Leverantörsfakturan finns inte.');
        const date=defaultPurchaseDate(state), due=new Date(`${date}T12:00:00Z`);
        due.setUTCDate(due.getUTCDate()+30);
        source = Purchases.copyBillPayload(original, { date, dueDate:due.toISOString().slice(0,10) });
      }
      draft = createPurchaseEditorDraft(state, source);
      if (current.mode === 'copy') { draft.id = ''; draft.number = ''; draft.attachments = []; }
      if (current.mode === 'new' && current.sourceId) {
        const metadata = documents.find(item => item.id === current.sourceId);
        if (metadata) draft.attachments = [metadata];
      }
      draftKey = current.key; dirty = false; selectedId = draft.attachments?.[0]?.id || null;
    }
    return renderPurchaseEditor(state, draft, { isNew: current.mode !== 'edit', documents, selectedDocumentId: selectedId });
  }
  async function mount() {
    if (!current || ['list'].includes(current.mode)) return;
    if (editor()) applyPurchaseVatMode(editor());
    const key = current.key;
    const version = generation;
    const wasLoaded = loaded;
    try { await loadDocuments(); } catch (error) { toast(error.message, true); }
    if (current?.key !== key || version !== generation) return;
    if (current.mode === 'inbox') {
      if (!wasLoaded && loaded) rerender();
      else await refreshViewer();
      return;
    }
    if (current.mode === 'new' && current.sourceId && !editorAttachments().length) {
      const metadata = documents.find(item => item.id === current.sourceId);
      if (metadata) setAttachments([metadata]);
    }
    await refreshViewer();
  }
  function assertNotLinkedElsewhere(items, billId) {
    for (const item of items) assert(!linkedBills(item.id).some(bill => bill.id !== billId),
      'Underlaget är redan kopplat till en annan leverantörsfaktura. Öppna den fakturan i inkorgen.');
  }
  async function attach(items) {
    const mutationVersion=mutationGeneration;
    requireWritable();
    const form = editor();
    const billId = form?.elements.namedItem('id')?.value || current?.id;
    assertNotLinkedElsewhere(items, billId);
    if (form) {
      const existing = editorAttachments();
      selectedId = items.at(-1)?.id || selectedId;
      setAttachments([...existing, ...items.filter(item => !existing.some(file => file.id === item.id))]);
      return true;
    }
    const bill = findBill(billId);
    assert(bill, 'Välj en leverantörsfaktura att koppla underlaget till.');
    const additional = items.filter(item => !billFiles(bill).some(file => file.id === item.id));
    if (!additional.length) { toast('Underlaget är redan kopplat till fakturan.'); return true; }
    await store.verifyDocuments(additional);
    if(mutationVersion!==mutationGeneration)return false;
    if (bill.status === 'draft') {
      return write(state => Purchases.updateBillDraft(state, bill.id, { ...bill, attachments:[...billFiles(bill), ...additional] }),
        'Underlaget har kopplats till fakturautkastet.');
    }
    return write(state => Purchases.addBillAttachments(state, bill.id, additional),
      'Underlaget har lagts till. Bokföringen och det ursprungliga underlaget är oförändrade.');
  }
  async function change(target) {
    if (target.matches('[data-document-upload]')) {
      const files = Array.from(target.files || []);
      if (!files.length) return;
      requireWritable();
      assert(!importing, 'Vänta tills den pågående uppladdningen är klar.');
      importing = true;
      const key = current?.key;
      const version = generation;
      try {
        await lock(async () => {
          requireWritable();
          const imported = await store.importFiles(files, { source: target.dataset.source || 'file' });
          await loadDocuments(true);
          if (current?.key === key && version === generation && current.mode !== 'inbox') {
            const success = await attach(imported);
            if (success && editor()) toast('Filen är lagrad i den lokala inkorgen. Spara utkastet för att behålla kopplingen.');
            if (!success) toast('Filen finns i inkorgen, men kopplingen kunde inte sparas.', true);
          } else {
            if (current?.mode === 'inbox') rerender();
            toast('Filen är lagrad i den lokala inkorgen.');
          }
        });
      } finally { importing = false; target.value = ''; }
      return;
    }
    if (target.closest('#purchase-page-form')) {
      const form = editor();
      if (target.dataset.purchaseField === 'vatMode') applyPurchaseVatMode(form);
      dirty = true; updateSummary();
    }
  }
  async function action(name,id,element) {
    if (!actions.has(name)) return false;
    switch (name) {
      case 'purchase-add-line': case 'purchase-remove-line':
        requireWritable(); changePurchaseLines(editor(), name, Number(id), getState()); dirty=true; updateSummary(); break;
      case 'new-bill': navigate('#purchases/new'); break;
      case 'show-bill': navigate(path(id)); break;
      case 'edit-bill': navigate(path(id,true)); break;
      case 'copy-bill': navigate('#purchases/copy/'+encodeURIComponent(id)); break;
      case 'purchase-back': navigate('#purchases'); break;
      case 'purchase-inbox': case 'open-document-inbox': navigate('#purchases/inbox'); break;
      case 'close-document-picker': closeDialog(); break;
      case 'close-inbox-preview': selectedId=null; rerender(); break;
      case 'reload-documents': await loadDocuments(true); rerender(); break;
      case 'create-bill-from-document': {
        const existing = linkedBills(id);
        navigate(existing.length ? path(existing[0].id) : '#purchases/new/'+encodeURIComponent(id)); break;
      }
      case 'open-document-picker': {
        const version=generation;
        await loadDocuments(true);
        if(version===generation)openDialog('Välj underlag från inkorgen','document-picker',renderDocumentPicker(documents,getState(),visibleFiles().map(file=>file.id)),'Klart'); break;
      }
      case 'attach-document': {
        const version=generation;
        const metadata = documents.find(item => item.id === id);
        assert(metadata, 'Underlaget finns inte längre i inkorgen.');
        await lock(async () => {
          await store.verifyDocuments([metadata]);
          if(version===generation)await attach([metadata]);
        });
        if(version===generation)closeDialog(); break;
      }
      case 'unlink-document':
        assert(editor(), 'Bokförda underlag kan inte kopplas bort.');
        requireWritable(); setAttachments(editorAttachments().filter(item => item.id !== id)); break;
      case 'select-document':
        selectedId = id; zoom = 1; rotation = 0; refreshPanel(); break;
      case 'select-inbox-document':
        selectedId = id; zoom = 1; rotation = 0; rerender(); break;
      case 'document-zoom-in': zoom = Math.min(3, zoom + .25); await refreshViewer(); break;
      case 'document-zoom-out': zoom = Math.max(.5, zoom - .25); await refreshViewer(); break;
      case 'document-rotate': rotation = (rotation + 90) % 360; await refreshViewer(); break;
      case 'document-reset': zoom = 1; rotation = 0; await refreshViewer(); break;
      case 'download-document': {
        const record = await store.get(id || selectedId);
        assert(record?.blob, 'Originalfilen saknas i den här webbläsaren.');
        const url = URL.createObjectURL(record.blob), a = document.createElement('a');
        a.href = url; a.download = record.name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); break;
      }
      case 'remove-inbox-document':
        requireWritable();
        assert(!linkedBills(id).length, 'Ett kopplat underlag kan inte raderas från inkorgen.');
        if (!window.confirm('Ta bort den okopplade filen från den här webbläsarens inkorg?')) break;
        await lock(async()=> {
          requireWritable();
          const latest=readStoredState();
          assert(!latest.bills.some(bill=>billFiles(bill).some(file=>file.id===id)), 'Underlaget har kopplats till en faktura.');
          await store.remove(id);
        });
        await loadDocuments(true); rerender(); toast('Den okopplade filen är borttagen.'); break;
      case 'link-document-existing': {
        assert(documents.some(item => item.id === id),'Underlaget finns inte i inkorgen.');
        const options = getState().bills.map(bill=>`<option value="${e(bill.id)}">${e(bill.supplier+' · '+bill.number)}</option>`).join('');
        assert(options,'Skapa en leverantörsfaktura först.');
        openDialog('Koppla till befintlig leverantörsfaktura','link-document',`<input type="hidden" name="documentId" value="${e(id)}"><label>Leverantörsfaktura<select name="billId" required>${options}</select></label><p class="form-help">Exempelvis en påminnelse kompletterar den befintliga fakturan. Ingen ny skuld eller verifikation skapas.</p>`,'Koppla underlag'); break;
      }
      case 'book-bill': {
        const bill = findBill(id); assert(bill,'Leverantörsfakturan finns inte.');
        openDialog('Granska och bokför leverantörsfaktura','purchase-book',`<input type="hidden" name="id" value="${e(id)}"><p>Kontrollera fakturauppgifter, underlag, moms och kontering. Bokförda uppgifter och de ursprungliga bilagorna låses.</p><label class="checkbox"><input type="checkbox" name="reviewed" required> Jag har granskat fakturan och konteringen</label>`,'Bokför fakturan'); break;
      }
    }
    return true;
  }
  async function submit(form) {
    const data = new FormData(form);
    if (form.dataset.form === 'document-picker') { closeDialog(); return; }
    if (form.dataset.form === 'purchase-page') {
      assert(!importing, 'Vänta tills uppladdningen är klar innan du sparar.');
      const payload = readPurchaseEditor(form), id = payload.id;
      const version = generation;
      await lock(async()=> {
        requireWritable(); assertNotLinkedElsewhere(payload.attachments || [], id);
        await store.verifyDocuments(payload.attachments || []);
        if(version!==generation || editor()!==form)return;
        await write(state => id ? Purchases.updateBillDraft(state,id,payload) : Purchases.createBill(state,payload),
          'Leverantörsfakturans utkast är sparat.', { after: state => { dirty=false; draft=null; draftKey=''; navigate(path(id || state.bills.at(-1).id)); } });
      });
      return;
    }
    if (form.dataset.form === 'purchase-book') {
      assert(data.has('reviewed'),'Bekräfta att du har granskat fakturan.');
      const id = String(data.get('id'));
      const mutationVersion=mutationGeneration;
      await lock(async()=> { requireWritable(); const bill=findBill(id); assert(bill,'Fakturan finns inte.'); await store.verifyDocuments(billFiles(bill));
        if(mutationVersion!==mutationGeneration)return;
        await write(state=>Purchases.bookBill(state,id),'Leverantörsfakturan är bokförd och sparad.'); });
      return;
    }
    if (form.dataset.form === 'link-document') {
      const mutationVersion=mutationGeneration;
      const id=String(data.get('billId')), fileId=String(data.get('documentId'));
      const metadata=documents.find(file=>file.id===fileId); assert(metadata,'Underlaget finns inte längre i inkorgen.');
      await lock(async()=> {
        requireWritable(); assertNotLinkedElsewhere([metadata],id); await store.verifyDocuments([metadata]);
        if(mutationVersion!==mutationGeneration)return;
        const bill=findBill(id); assert(bill,'Leverantörsfakturan finns inte.');
        const additional=billFiles(bill).some(file=>file.id===fileId)?[]:[metadata];
        assert(additional.length,'Underlaget är redan kopplat till den fakturan.');
        const success=await write(state=>bill.status==='draft'
          ? Purchases.updateBillDraft(state,id,{...bill,attachments:[...billFiles(bill),metadata]})
          : Purchases.addBillAttachments(state,id,[metadata]),
        'Underlaget har kopplats till den befintliga fakturan.',{after:()=>navigate(path(id))});
        if(success) dirty=false;
      });
    }
  }
  return {
    render, mount, action, change, submit, discard,
    isDirty:()=>dirty,
    isEditor:()=>!!editor(),
    handlesAction:name=>actions.has(name),
    handlesForm:name=>forms.has(name),
    handlesChange:target=>target.matches('[data-document-upload]')||!!target.closest('#purchase-page-form'),
    input:target=>{if(target.closest('#purchase-page-form')){dirty=true;updateSummary();}},
  };
}
