(function () {
  'use strict';

  const messages = [
    {
      id: 'exchange', from: 'Maria Lind', company: 'Elektriska AB', initials: 'ML',
      address: 'maria@elektriska.example', subject: 'Utbyte av kabelkärl på fredag',
      preview: 'Vårt 660-literskärl är fullt. Kan ni byta på fredag?', time: '09:24', unread: true,
      kind: 'Utbyte', customer: 'Elektriska AB', vessel: 'K-0660', agreement: 'AV-0044',
      text: 'Hej!\n\nVårt 660-literskärl med kablar är fullt. Kan ni byta det på fredag, gärna före lunch?\n\nDet står på baksidan av verkstaden på Nordvägen 12, Norrtälje. Samma plats som tidigare.\n\nTack!\nMaria Lind\nElektriska AB',
    },
    {
      id: 'carrier', from: 'Johan Berg', company: 'Roslagens Åkeri', initials: 'JB',
      address: 'trafik@roslagensakeri.example', subject: 'SV: Förfrågan AO-1052 – vi kan köra',
      preview: 'Vi tackar ja. Skulle torsdag förmiddag passa?', time: '08:58', unread: true,
      kind: 'Åkerisvar', order: 'AO-1052',
      text: 'Hej!\n\nVi tackar ja till förfrågan för AO-1052. Vi har bil tillgänglig torsdag förmiddag. Skulle det passa er?\n\nFöraren blir Johan Berg. Återkom gärna om tid och lastning.\n\nVänliga hälsningar\nJohan\nRoslagens Åkeri',
    },
    {
      id: 'new-customer', from: 'Anders Nilsson', company: 'Rimbo Elservice', initials: 'AN',
      address: 'anders@rimboel.example', subject: 'Hämtning av blybatterier',
      preview: 'Vi har ungefär åtta batterier. Vad kostar hämtning?', time: '08:35', unread: false,
      kind: 'Ny förfrågan',
      text: 'Hej!\n\nVi har ungefär åtta uttjänta blybatterier som vi vill bli av med. Kan ni hämta nästa vecka? Vad kostar det?\n\nMvh\nAnders Nilsson\nRimbo Elservice\n070-123 45 67',
    },
    {
      id: 'permit', from: 'Eva Holm', company: 'Miljökonsulten', initials: 'EH',
      address: 'eva@miljokonsult.example', subject: 'Tillstånd Norrtälje – ny bilaga',
      preview: 'Bifogar underlag för kontroll av lagringsvillkoren.', time: 'Igår', unread: false,
      kind: 'Bilaga', attachment: 'Tillstånd-Norrtälje.pdf',
      text: 'Hej!\n\nHär kommer underlaget vi talade om. Kontrollera dokumentets beslut, giltighet och omfattning innan ni uppdaterar anläggningens lagringsvillkor.\n\nHälsningar\nEva Holm\nMiljökonsulten',
    },
  ];
  const state = {
    selected: 'exchange', folder: 'inbox', mobileDetail: false, search: '',
    assigned: {}, handled: {}, archived: {}, read: {}, drafts: {}, sent: {},
    orders: {}, orderDetails: {}, review: null, reviewValues: null, errors: {}, nextOrder: 1101,
  };
  let mounted = null;
  let helpers = {};
  let priorFocus = null;
  let keyboardTarget = null;
  let keyboardHandler = null;
  const observedSignals = new WeakSet();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name) => {
    const names = { mail: 'Mail', user: 'UserRound', check: 'Check', archive: 'Archive', link: 'Link', chevronRight: 'ChevronRight', arrowLeft: 'ArrowLeft', file: 'FileText', send: 'Send', sparkles: 'Sparkles', clock: 'Clock3', shield: 'ShieldCheck', plus: 'Plus', x: 'X', external: 'ExternalLink', settings: 'Settings2', search: 'Search' };
    try { return window.MockupUI?.icon(names[name] || name) || ''; } catch (_) { return ''; }
  };
  const pill = (text, tone = 'blue') => `<span class="inbox-pill inbox-pill-${tone}">${esc(text)}</span>`;
  const button = (label, action, kind = 'outline', symbol = '', attrs = '') => `<button type="button" class="button ${kind}" data-inbox-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}<span>${esc(label)}</span></button>`;
  const source = (label) => `<span class="inbox-source">${esc(label)}</span>`;
  const selected = () => messages.find((m) => m.id === state.selected) || messages[0];
  const notify = (text) => helpers.toast?.(text);
  const isUnread = (m) => m.unread && !state.read[m.id];
  const unreadCount = () => messages.filter((m) => !state.archived[m.id] && !state.handled[m.id] && isUnread(m)).length;

  function folders() {
    const definitions = [
      ['inbox', 'Inkorg', 'mail', messages.filter((m) => !state.archived[m.id] && !state.handled[m.id]).length],
      ['unread', 'Olästa', 'mail', unreadCount()],
      ['assigned', 'Mina ärenden', 'user', Object.keys(state.assigned).filter((id) => !state.handled[id] && !state.archived[id]).length],
      ['handled', 'Hanterade', 'check', Object.keys(state.handled).length],
      ['archive', 'Arkiv', 'archive', Object.keys(state.archived).length],
    ];
    return definitions.map(([id, label, symbol, count]) => `<button type="button" class="inbox-folder ${state.folder === id ? 'is-active' : ''}" data-inbox-action="folder" data-id="${id}">${icon(symbol)}<span>${label}</span>${count ? `<b>${count}</b>` : ''}</button>`).join('');
  }

  function visibleMessages() {
    return messages.filter((m) => {
      const folderMatch = state.folder === 'archive' ? state.archived[m.id]
        : state.folder === 'handled' ? state.handled[m.id] && !state.archived[m.id]
          : state.folder === 'assigned' ? state.assigned[m.id] && !state.handled[m.id] && !state.archived[m.id]
            : state.folder === 'unread' ? isUnread(m) && !state.handled[m.id] && !state.archived[m.id]
              : !state.handled[m.id] && !state.archived[m.id];
      return folderMatch && `${m.subject} ${m.from} ${m.company}`.toLocaleLowerCase('sv').includes(state.search.toLocaleLowerCase('sv'));
    });
  }

  function messageList() {
    const items = visibleMessages();
    return items.length ? items.map((m) => `<button type="button" class="inbox-message ${state.selected === m.id ? 'is-selected' : ''} ${isUnread(m) ? 'is-unread' : ''}" data-inbox-action="select" data-id="${m.id}" aria-label="Öppna ${esc(m.subject)}">
      <span class="inbox-message-top"><strong>${esc(m.company)}</strong><time>${esc(m.time)}</time></span>
      <span class="inbox-message-subject">${isUnread(m) ? '<i class="inbox-unread-dot" aria-label="Oläst"></i>' : ''}${esc(m.subject)}</span>
      <span class="inbox-message-preview">${esc(m.preview)}</span>
      <span class="inbox-message-tags">${pill(m.kind, 'muted')}${state.orders[m.id] ? pill(state.orders[m.id], 'green') : m.order ? pill(m.order, 'blue') : ''}${state.assigned[m.id] ? '<span class="inbox-assigned-small">Tilldelad dig</span>' : ''}</span>
    </button>`).join('') : '<div class="inbox-list-empty">Inga mejl i den här vyn.</div>';
  }

  function linkedEntities(m) {
    let items = [];
    if (m.customer) items.push(['Kund', m.customer, 'customer']);
    if (m.vessel) items.push(['Kärl', `${m.vessel} · 660 l`, 'vessel']);
    if (m.agreement) items.push(['Avtal', m.agreement, 'agreement']);
    const order = state.orders[m.id] || m.order;
    if (order) items.push(['Arbetsorder', order, 'order']);
    if (!items.length) return `<div class="inbox-entity-note">${icon('link')}<span>${m.id === 'permit' ? 'Förslag: koppla till anläggningen Norrtälje efter granskning.' : 'Ingen säker kundmatchning. Välj eller skapa kund vid granskning.'}</span></div>`;
    return `<div class="inbox-entities">${items.map(([label, value, kind]) => `<button type="button" data-inbox-action="entity" data-kind="${kind}" data-value="${esc(value)}"><span>${label}</span><strong>${esc(value)}</strong>${icon('chevronRight')}</button>`).join('')}</div>`;
  }

  function replyDraft(m) {
    if (!Object.prototype.hasOwnProperty.call(state.drafts, m.id)) return '';
    return `<section class="inbox-draft" aria-label="Svarsutkast">
      <div class="inbox-section-heading"><h3>Svarsutkast</h3>${pill('Inte skickat', 'muted')}</div>
      <div class="inbox-draft-recipient">Till: <strong>${esc(m.address)}</strong></div>
      <textarea class="field inbox-reply-text" data-inbox-input="reply" aria-label="Redigera svarsutkast" rows="7">${esc(state.drafts[m.id])}</textarea>
      <div class="inbox-draft-footer"><span>Du granskar och skickar själv.</span><div>${button('Spara utkast', 'save-draft', 'outline')}${button('Skicka · demo', 'send-reply', 'primary', 'send')}</div></div>
    </section>`;
  }

  function emailThread(m) {
    return `<section class="panel inbox-thread" aria-label="Valt mejl">
      <div class="inbox-thread-toolbar">
        <button type="button" class="text-button inbox-mobile-back" data-inbox-action="back">${icon('arrowLeft')} Till inkorgen</button>
        <span class="inbox-thread-breadcrumb">Inkorg <span>/</span> ${esc(m.kind)}</span>
        <div class="inbox-thread-actions">
          <button type="button" class="icon-button ${state.assigned[m.id] ? 'is-active' : ''}" data-inbox-action="assign" title="${state.assigned[m.id] ? 'Ta bort min tilldelning' : 'Tilldela mig'}" aria-label="Tilldela mig">${icon('user')}</button>
          <button type="button" class="icon-button" data-inbox-action="handled" title="Markera hanterat" aria-label="Markera hanterat">${icon('check')}</button>
          <button type="button" class="icon-button" data-inbox-action="archive" title="Arkivera" aria-label="Arkivera">${icon('archive')}</button>
        </div>
      </div>
      <header class="inbox-email-heading"><h2>${esc(m.subject)}</h2><div class="inbox-email-from"><span class="inbox-avatar">${m.initials}</span><div><strong>${esc(m.from)}</strong><span>${esc(m.address)}</span></div><time>${esc(m.time)}<small>12 oktober 2026</small></time></div>
        <p class="inbox-email-to">Till transport@jeroc.example ${state.assigned[m.id] ? '<span>· Tilldelad dig</span>' : ''}</p>
      </header>
      ${linkedEntities(m)}
      <div class="inbox-email-body">${esc(m.text).replace(/\n/g, '<br>')}</div>
      ${m.attachment ? `<div class="inbox-attachment">${icon('file')}<div><strong>${esc(m.attachment)}</strong><span>PDF · 4 sidor · exempelbilaga</span></div>${button('Förhandsvisa', 'attachment', 'outline')}</div>` : ''}
      ${state.sent[m.id] ? `<div class="inbox-sent-note">${icon('check')}<div><strong>Demonstrerat svar</strong><p>${esc(state.sent[m.id]).replace(/\n/g, '<br>')}</p><small>Ingen e-post har skickats.</small></div></div>` : ''}
      <div class="inbox-email-bottom">${button('Föreslå svar', 'propose-reply', 'outline', 'sparkles')}${button(state.handled[m.id] ? 'Markera som pågående' : 'Markera hanterat', 'handled', 'text-button', 'check')}</div>
      ${replyDraft(m)}
    </section>`;
  }

  function suggestionRow(label, value, reference, missing = false) {
    return `<div class="inbox-extracted-row ${missing ? 'is-missing' : ''}"><span>${esc(label)}</span><div><strong>${esc(value)}</strong>${source(reference)}</div></div>`;
  }

  function aiPane(m) {
    let content;
    if (m.id === 'exchange') {
      content = `<div class="inbox-suggestion-lead">${pill('Utbyte av kärl', 'blue')}<h3>Förbered en arbetsorder</h3><p>Kunden vill byta sitt fulla kabelkärl. Ett befintligt kärl och avtal matchar mejlet.</p></div>
        <div class="inbox-extracted">
          ${suggestionRow('Kund', 'Elektriska AB', 'Kundregister · e-postmatchning')}
          ${suggestionRow('Kärl', 'K-0660 · Kabel · 660 l', 'Mejlet + kärlregister')}
          ${suggestionRow('Plats', 'Nordvägen 12, Norrtälje', 'Mejlet + avtal AV-0044')}
          ${suggestionRow('Önskad tid', 'Fre 16 okt · före lunch', 'Mejlet · relativt datum tolkat')}
        </div><div class="inbox-ai-note">${icon('clock')}<span>Tiden är ett önskemål. Förare och bokad tid väljs i planeringen.</span></div>
        ${state.orders[m.id] ? `<div class="inbox-complete-note">${icon('check')}<span>Kopplad till <strong>${state.orders[m.id]}</strong>. Skapa inte en ny order för samma mejl.</span></div>${button('Granska kopplad order', 'review-order', 'outline', 'file')}` : button('Förbered arbetsorder', 'review-order', 'primary', 'plus')}
        <div class="inbox-ai-secondary"><h4>Förslag på svar</h4><p>Bekräfta att önskemålet är mottaget och att planeringen återkommer med tid.</p>${button('Föreslå svar', 'propose-reply', 'outline', 'sparkles')}</div>`;
    } else if (m.id === 'carrier') {
      content = `<div class="inbox-suggestion-lead">${pill('Svar på befintlig förfrågan', 'green')}<h3>Åkeriet tackar ja</h3><p>Mejlet gäller en arbetsorder som redan finns. Koppla svaret till den ordern och granska föreslagen tid.</p></div><div class="inbox-extracted">
        ${suggestionRow('Arbetsorder', 'AO-1052 · Utleverans', 'Mejlets ämne + arbetsorder')}
        ${suggestionRow('Åkeri', 'Roslagens Åkeri', 'Avsändare + åkeriregister')}
        ${suggestionRow('Föreslagen tid', 'Torsdag förmiddag', 'Mejlet · önskemål')}
        ${suggestionRow('Förare', 'Johan Berg', 'Mejlet · behöver bekräftas')}
      </div><div class="inbox-ai-note">${icon('link')}<span>AO-1052 finns redan. Ingen ny arbetsorder behövs.</span></div>${button('Granska AO-1052', 'review-order', 'primary', 'file')}<div class="inbox-ai-secondary"><h4>Fortsätt i arbetsordern</h4><p>Granska svaret före ändring av status, förare eller bokad tid.</p>${button('Föreslå svar', 'propose-reply', 'outline', 'sparkles')}</div>`;
    } else if (m.id === 'new-customer') {
      content = `<div class="inbox-suggestion-lead">${pill('Behöver kompletteras', 'orange')}<h3>Be om hämtplats</h3><p>En förfrågan om farligt avfall. Platsen saknas och företaget är inte säkert matchat mot en kund.</p></div><div class="inbox-extracted">
        ${suggestionRow('Företag', 'Rimbo Elservice', 'Mejlets signatur · inte verifierat')}
        ${suggestionRow('Material', 'Blybatterier', 'Mejlet + artikelregister')}
        ${suggestionRow('Antal', 'Cirka 8 st', 'Mejlet · vikt saknas')}
        ${suggestionRow('Hämtplats', 'Saknas', 'Komplettering krävs', true)}
      </div><div class="inbox-ai-note inbox-ai-note-warning">${icon('shield')}<span>Uppskatta inte vikt, adress eller transportuppgifter. Miljöunderlag granskas i det ordinarie flödet.</span></div>${button('Föreslå kompletteringsmejl', 'propose-reply', 'primary', 'sparkles')}${button('Förbered arbetsorder', 'review-order', 'outline', 'plus')}`;
    } else {
      content = `<div class="inbox-suggestion-lead">${pill('Dokument att granska', 'orange')}<h3>Kontrollera tillståndet</h3><p>AI kan hjälpa till att läsa bilagan och föreslå fält. Giltighet och lagringsvillkor behöver godkännas av ansvarig.</p></div><div class="inbox-extracted">
        ${suggestionRow('Anläggning', 'Norrtälje', 'Mejlets ämne · föreslagen koppling')}
        ${suggestionRow('Dokument', 'Tillstånd-Norrtälje.pdf', 'Bilaga')}
        ${suggestionRow('Giltighet', 'Inte kontrollerad', 'Granska beslutet', true)}
        ${suggestionRow('Lagringsvillkor', 'Inte fastställda', 'Granska hela dokumentet', true)}
      </div><div class="inbox-ai-note inbox-ai-note-warning">${icon('shield')}<span>Inga tillstånd, klassificeringar eller lagringsgränser ändras automatiskt.</span></div>${button('Granska dokumentförslag', 'review-permit', 'primary', 'file')}${button('Föreslå svar', 'propose-reply', 'outline', 'sparkles')}`;
    }
    return `<aside class="panel inbox-ai" aria-label="AI-förslag"><div class="inbox-ai-header"><span class="inbox-ai-symbol">${icon('sparkles')}</span><div><h2>AI-förslag</h2><p>Granska innan du går vidare</p></div>${pill('Förslag', 'violet')}</div>${content}<footer class="inbox-ai-footer">Förslagen bygger på mejlet och dina tillåtna registeruppgifter. Originalmejlet är kvar.</footer></aside>`;
  }

  function modalField(label, name, value, reference, required = false, type = 'text') {
    return `<label class="inbox-review-field"><span>${label}${required ? ' <b>*</b>' : ''}</span><input class="field ${state.errors[name] ? 'has-error' : ''}" name="${name}" type="${type}" value="${esc(value)}" ${required ? 'aria-required="true"' : ''} ${name === 'place' ? 'placeholder="Gatuadress, postnummer och ort"' : ''}>${reference ? source(reference) : ''}${state.errors[name] ? `<small class="inbox-field-error">${esc(state.errors[name])}</small>` : ''}</label>`;
  }

  function workOrderReview(m) {
    const duplicate = state.orders[m.id] || m.order;
    const newCustomer = m.id === 'new-customer';
    const id = duplicate || 'Ny arbetsorder';
    const values = state.reviewValues || state.orderDetails[m.id] || {};
    const value = (name, fallback) => values[name] ?? fallback;
    const orderType = value('orderType', newCustomer ? 'Hämtning' : m.id === 'carrier' ? 'Utleverans' : 'Utbyte');
    const transport = value('transport', m.id === 'carrier' ? 'external' : 'own');
    return `<div class="inbox-review-overlay"><section class="inbox-review-dialog" role="dialog" aria-modal="true" aria-labelledby="inbox-review-title" tabindex="-1">
      <header class="inbox-review-heading"><div><span class="inbox-eyebrow">Från mejl · granskningssteg</span><h2 id="inbox-review-title">${duplicate ? `Granska ${esc(id)}` : 'Granska arbetsorderförslaget'}</h2><p>${duplicate ? 'En befintlig order matchar ärendet. Skapa inte en kopia.' : 'Bekräfta uppgifterna innan ett utkast skapas.'}</p></div><button class="icon-button" type="button" aria-label="Stäng granskningsfönstret" data-inbox-action="close-review">${icon('x')}</button></header>
      <div class="inbox-review-body">
        <div class="inbox-review-context">${icon('mail')}<div><strong>${esc(m.subject)}</strong><span>${esc(m.company)} · transport@jeroc.example</span></div>${pill('Utkast', 'blue')}</div>
        ${duplicate ? `<div class="inbox-review-duplicate">${icon('link')}<div><strong>${esc(id)} finns redan</strong><p>${m.id === 'carrier' ? 'Åkeriets ja och tidförslag ska granskas i den befintliga arbetsordern. Inga ändringar har gjorts där.' : 'Den här mejlförfrågan har redan en kopplad demoorder.'}</p></div></div>` : ''}
        <form class="inbox-review-form" onsubmit="return false">
          <div class="inbox-review-grid">
            <label class="inbox-review-field"><span>Typ av uppdrag</span><select class="field" name="orderType">${['Utbyte', 'Hämtning', 'Utleverans'].map((type) => `<option ${orderType === type ? 'selected' : ''}>${type}</option>`).join('')}</select>${source(newCustomer ? 'Mejlet' : m.id === 'carrier' ? 'Befintlig arbetsorder' : 'Mejlet + avtal')}</label>
            ${modalField('Kund', 'customer', value('customer', newCustomer ? 'Rimbo Elservice · behöver matchas' : 'Elektriska AB'), newCustomer ? 'Mejlet · verifiera kund' : 'Kundregister')}
            ${modalField('Hämtplats / ursprung', 'place', value('place', newCustomer ? '' : m.id === 'carrier' ? 'Ängsvägen 19, 761 41 Norrtälje' : 'Nordvägen 12, 761 42 Norrtälje'), newCustomer ? 'Saknas i mejlet' : 'Mejlet + befintlig plats', newCustomer)}
            ${modalField('Kärl / material', 'material', value('material', newCustomer ? 'Blybatterier · cirka 8 st · vikt ej angiven' : m.id === 'carrier' ? 'Blybatterier · enligt AO-1052' : 'K-0660 · 660 l · elkablar'), newCustomer ? 'Mejlet + artikelregister' : 'Kärlregister + avtal')}
            ${modalField('Önskat datum', 'requestedDate', value('requestedDate', newCustomer ? '2026-10-19' : m.id === 'carrier' ? '2026-10-15' : '2026-10-16'), newCustomer ? 'Nästa vecka · förslag, inte bokat' : 'Mejlet · önskemål', false, 'date')}
            ${modalField('Önskad tid', 'requestedTime', value('requestedTime', newCustomer ? '' : m.id === 'carrier' ? 'Förmiddag' : 'Före lunch'), 'Mejlet · önskemål')}
            <label class="inbox-review-field"><span>Transport</span><select class="field" name="transport"><option value="own" ${transport === 'own' ? 'selected' : ''}>Egen chaufför</option><option value="external" ${transport === 'external' ? 'selected' : ''}>Externt åkeri</option></select>${source(m.id === 'carrier' ? 'Befintlig order' : 'Förvalt arbetssätt')}</label>
            ${modalField('Förare', 'driver', value('driver', m.id === 'carrier' ? 'Johan Berg · behöver bekräftas' : 'Tilldelas i planeringen'), m.id === 'carrier' ? 'Mejlet · förslag' : 'Ingen automatisk tilldelning')}
          </div>
          <div class="inbox-review-agreement">${icon('file')}<div><strong>${newCustomer ? 'Avtal saknas i kundmatchningen' : m.id === 'carrier' ? 'Kopplad arbetsorder AO-1052' : 'AV-0044 · Kabelkärl 660 l'}</strong><p>${newCustomer ? 'Pris och uppdragsvillkor behöver granskas. Angivet antal skapar ingen invägd vikt.' : m.id === 'carrier' ? 'Tid, förare och transportdokument granskas innan avfärd.' : 'Utbyte enligt befintligt avtal. Lastplats: baksidan av verkstaden.'}</p></div></div>
          <label class="inbox-review-field"><span>Planeringsanteckning</span><textarea class="field" name="note" rows="2">${esc(value('note', newCustomer ? 'Ny förfrågan. Kundmatchning och pris behöver kontrolleras före bokning.' : m.id === 'carrier' ? 'Åkeriet tackar ja och föreslår torsdag förmiddag.' : 'Kunden önskar fredag före lunch. Bekräfta bokad tid separat.'))}</textarea></label>
        </form>
        <div class="inbox-review-info">${icon('clock')}<span><strong>Tid är ett önskemål.</strong> Detta steg skickar inget mejl och bokar ingen förare. Utkastet granskas vidare i Arbetsorder.</span></div>
      </div>
      <footer class="inbox-review-footer"><span>${duplicate ? 'Dubblettskydd · ingen ny order skapas' : 'Demomiljö · inga register ändras'}</span><div>${button('Avbryt', 'close-review', 'outline')}${duplicate ? button(`Öppna ${id}`, 'open-existing', 'primary', 'external') : button('Skapa utkast · demo', 'confirm-order', 'primary', 'check')}</div></footer>
    </section></div>`;
  }

  function permitReview(m) {
    return `<div class="inbox-review-overlay"><section class="inbox-review-dialog inbox-permit-dialog" role="dialog" aria-modal="true" aria-labelledby="inbox-review-title" tabindex="-1"><header class="inbox-review-heading"><div><span class="inbox-eyebrow">Dokumentförslag · ingen ändring sparad</span><h2 id="inbox-review-title">Granska bilagan</h2><p>Uppgifterna kräver kontroll mot originaldokumentet.</p></div><button class="icon-button" type="button" aria-label="Stäng granskningsfönstret" data-inbox-action="close-review">${icon('x')}</button></header><div class="inbox-review-body"><div class="inbox-document-preview">${icon('file')}<h3>${esc(m.attachment)}</h3><p>Exempel på dokumentförhandsvisning</p><span>Ingen verklig PDF är bifogad i denna mockup.</span></div><div class="inbox-review-grid">${modalField('Föreslagen anläggning', 'site', 'Norrtälje', 'Mejlets ämne · behöver bekräftas')}${modalField('Beslutsnummer', 'decision', '', 'Inte läst / inte fastställt')}${modalField('Gäller från', 'validFrom', '', 'Kontrollera originalet', false, 'date')}${modalField('Gäller till', 'validTo', '', 'Kontrollera originalet', false, 'date')}</div><div class="inbox-review-info">${icon('shield')}<span>En ansvarig måste kontrollera utfärdare, beslut, avfallskoder och mängdgränser. AI-förslaget ändrar inga lagringsvillkor.</span></div></div><footer class="inbox-review-footer"><span>En granskningsuppgift kan förberedas.</span><div>${button('Stäng', 'close-review', 'outline')}${button('Förbered granskning · demo', 'permit-task', 'primary', 'check')}</div></footer></section></div>`;
  }

  function render() {
    const m = selected();
    return `<div class="inbox-page ${state.mobileDetail ? 'inbox-show-detail' : ''}">
      <header class="inbox-page-heading"><div><span class="inbox-eyebrow">Kommunikation & uppdrag</span><h1>Inkorg</h1><p>Från förfrågan till nästa åtgärd, med sammanhanget nära.</p></div><div class="inbox-page-meta">${pill('Outlook · Designförslag', 'blue')}${button('Brevlådor & åtkomst', 'mailbox-settings', 'outline', 'settings')}</div></header>
      <div class="inbox-demo-bar">${icon('sparkles')}<span>Exempelmejl och AI-förslag. Granska varje åtgärd själv; inget skickas automatiskt.</span></div>
      <div class="inbox-layout">
        <aside class="panel inbox-nav" aria-label="Brevlåda och mejllista"><div class="inbox-mailbox"><span class="inbox-mailbox-icon">${icon('mail')}</span><div><strong>Transport</strong><span>transport@jeroc.example</span></div><span class="inbox-shared-tag">Delad</span></div><nav class="inbox-folders" aria-label="Mejlmappar">${folders()}</nav><div class="inbox-list-heading"><strong>${{ inbox: 'Inkorg', unread: 'Olästa', assigned: 'Mina ärenden', handled: 'Hanterade', archive: 'Arkiv' }[state.folder]}</strong><span>${visibleMessages().length} mejl</span></div><label class="inbox-search">${icon('search')}<input class="field" type="search" placeholder="Sök i inkorgen…" aria-label="Sök i inkorgen" data-inbox-input="search" value="${esc(state.search)}"></label><div class="inbox-message-list">${messageList()}</div><footer class="inbox-nav-footer">${icon('shield')}<span>Endast brevlådor du har åtkomst till.</span></footer></aside>
        ${emailThread(m)}${aiPane(m)}
      </div>
      ${state.review === 'order' ? workOrderReview(m) : state.review === 'permit' ? permitReview(m) : ''}
    </div>`;
  }

  function paint() {
    if (!mounted) return;
    mounted.innerHTML = render();
    bind(mounted, helpers);
    if (state.review) {
      document.body.classList.add('inbox-modal-open');
      mounted.querySelector('[role="dialog"]')?.focus({ preventScroll: true });
    } else document.body.classList.remove('inbox-modal-open');
  }

  function defaultReply(m) {
    if (m.id === 'exchange') return 'Hej Maria!\n\nTack för din förfrågan. Vi har tagit emot önskemålet om utbyte av kabelkärlet på fredag före lunch. Planeringen återkommer med en bekräftad tid.\n\nVänliga hälsningar\nJEROC Återvinning';
    if (m.id === 'carrier') return 'Hej Johan!\n\nTack för ert svar på AO-1052. Vi har noterat att ni kan köra och att ni föreslår torsdag förmiddag. Vi återkommer med bekräftad tid och uppgifter inför avfärd.\n\nVänliga hälsningar\nJEROC Återvinning';
    if (m.id === 'new-customer') return 'Hej Anders!\n\nTack för din förfrågan. Vilken adress finns blybatterierna på? Skicka gärna också företagets organisationsnummer och uppgifter om hur batterierna är förvarade, så kan vi kontrollera hämtning och pris.\n\nVänliga hälsningar\nJEROC Återvinning';
    return 'Hej Eva!\n\nTack för underlaget. Vi lämnar det till ansvarig för granskning av beslut, giltighet och lagringsvillkor.\n\nVänliga hälsningar\nJEROC Återvinning';
  }

  function closeReview() {
    state.review = null;
    state.reviewValues = null;
    state.errors = {};
    paint();
    priorFocus && mounted?.querySelector(`[data-inbox-action="${priorFocus}"]`)?.focus({ preventScroll: true });
  }

  function action(element) {
    const name = element.dataset.inboxAction;
    const m = selected();
    if (name === 'select') { state.selected = element.dataset.id; state.mobileDetail = true; state.read[state.selected] = true; paint(); }
    else if (name === 'folder') { state.folder = element.dataset.id; state.mobileDetail = false; paint(); }
    else if (name === 'back') { state.mobileDetail = false; paint(); }
    else if (name === 'assign') { state.assigned[m.id] ? delete state.assigned[m.id] : state.assigned[m.id] = true; paint(); notify(state.assigned[m.id] ? 'Mejlet är tilldelat dig i demonstrationen.' : 'Din tilldelning har tagits bort.'); }
    else if (name === 'handled') { state.handled[m.id] ? delete state.handled[m.id] : state.handled[m.id] = true; paint(); notify(state.handled[m.id] ? 'Mejlet är markerat som hanterat i demonstrationen.' : 'Mejlet är pågående igen.'); }
    else if (name === 'archive') { state.archived[m.id] = true; state.mobileDetail = false; paint(); notify('Mejlet har flyttats till Arkiv i demonstrationen.'); }
    else if (name === 'propose-reply') { if (!Object.prototype.hasOwnProperty.call(state.drafts, m.id)) state.drafts[m.id] = defaultReply(m); paint(); mounted.querySelector('[data-inbox-input="reply"]')?.focus({ preventScroll: true }); }
    else if (name === 'save-draft') { state.drafts[m.id] = mounted.querySelector('[data-inbox-input="reply"]')?.value || ''; notify('Svarsutkast sparat i demonstrationen. Inget mejl har skickats.'); }
    else if (name === 'send-reply') { const draft = mounted.querySelector('[data-inbox-input="reply"]')?.value.trim(); if (!draft) return notify('Skriv ett svar först.'); state.sent[m.id] = draft; delete state.drafts[m.id]; paint(); notify('Skickat-läget visas nu. Ingen riktig e-post har skickats.'); }
    else if (name === 'review-order') { state.review = 'order'; state.reviewValues = null; state.errors = {}; priorFocus = name; paint(); }
    else if (name === 'close-review') closeReview();
    else if (name === 'confirm-order') {
      if (state.orders[m.id] || m.order) return notify('En arbetsorder finns redan. Granska den i stället.');
      const form = mounted.querySelector('.inbox-review-form');
      const place = form?.elements.namedItem('place')?.value.trim();
      state.reviewValues = Object.fromEntries(new FormData(form));
      if (m.id === 'new-customer' && !place) { state.errors = { place: 'Fyll i hämtplats eller be kunden komplettera.' }; paint(); mounted.querySelector('[name="place"]')?.focus({ preventScroll: true }); return; }
      state.orders[m.id] = `AO-DEMO-${state.nextOrder++}`;
      state.orderDetails[m.id] = { ...state.reviewValues };
      state.review = null; state.reviewValues = null; state.errors = {}; paint();
      notify(`${state.orders[m.id]} är förberedd och kopplad till mejlet. Ingen transport är bokad och inget mejl skickat.`);
    }
    else if (name === 'open-existing') { closeReview(); helpers.openCase?.('workorder', state.orders[m.id] || m.order); }
    else if (name === 'entity') { const value = element.dataset.value; if (element.dataset.kind === 'order') helpers.openCase?.('workorder', value); else notify(`${value}: här länkas till ${element.dataset.kind === 'customer' ? 'kundkortet' : element.dataset.kind === 'vessel' ? 'kärlet' : 'avtalet'} i den färdiga appen.`); }
    else if (name === 'review-permit' || name === 'attachment') { state.review = 'permit'; priorFocus = name; paint(); }
    else if (name === 'permit-task') { closeReview(); notify('En granskningsuppgift har förberetts i demonstrationen. Inga lagringsvillkor ändras.'); }
    else if (name === 'mailbox-settings') {
      notify('Delad brevlåda: transport@jeroc.example. Planerade inställningar: Outlook-koppling, läs-/svarsrättigheter och ansvariga användare.');
    }
  }

  function bind(container, availableHelpers) {
    mounted = container;
    helpers = availableHelpers || {};
    const options = helpers.signal ? { signal: helpers.signal } : undefined;
    if (helpers.signal && !observedSignals.has(helpers.signal)) {
      observedSignals.add(helpers.signal);
      helpers.signal.addEventListener('abort', () => { document.body.classList.remove('inbox-modal-open'); state.review = null; state.reviewValues = null; }, { once: true });
    }
    container.querySelectorAll('[data-inbox-action]').forEach((element) => element.addEventListener('click', () => action(element), options));
    container.querySelector('[data-inbox-input="reply"]')?.addEventListener('input', (event) => { state.drafts[selected().id] = event.target.value; }, options);
    container.querySelector('[data-inbox-input="search"]')?.addEventListener('input', (event) => {
      state.search = event.target.value;
      const list = container.querySelector('.inbox-message-list');
      list.innerHTML = messageList();
      container.querySelector('.inbox-list-heading>span').textContent = `${visibleMessages().length} mejl`;
      list.querySelectorAll('[data-inbox-action]').forEach((element) => element.addEventListener('click', () => action(element), options));
    }, options);
    const overlay = container.querySelector('.inbox-review-overlay');
    overlay?.addEventListener('click', (event) => { if (event.target === overlay) closeReview(); }, options);
    if (keyboardTarget && keyboardHandler) keyboardTarget.removeEventListener('keydown', keyboardHandler);
    keyboardTarget = container;
    keyboardHandler = (event) => {
      if (!state.review) return;
      if (event.key === 'Escape') { event.preventDefault(); closeReview(); }
      if (event.key === 'Tab') {
        const focusable = Array.from(container.querySelectorAll('[role="dialog"] button:not([disabled]), [role="dialog"] input, [role="dialog"] select, [role="dialog"] textarea'));
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement?.matches('[role="dialog"]'))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    container.addEventListener('keydown', keyboardHandler, options);
  }

  function openMessage(id) {
    if (!messages.some((m) => m.id === id)) id = 'exchange';
    state.selected = id; state.mobileDetail = true; state.read[id] = true; state.review = null;
    document.body.classList.remove('inbox-modal-open');
    return id;
  }

  window.InboxMockup = { render, bind, openMessage };
}());
