import { ACCOUNTS, money } from './core.js';
import { fiscalPeriods } from './fiscal-periods.js';
import { decodeSie, encodeSiePc8 as encodeReceipt, exportSie4, importSie4, previewSieImport, SIE_SPEC, SIE_LIMITS } from './sie.js';
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const yearKey = year => `${year.start}/${year.end}`;
const table = (headers, rows) => `<div class="sie-table"><table><thead><tr>${headers.map(header=>`<th>${e(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const mappingFrom = value => { try { const parsed=JSON.parse(value||'{}'); if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error(); return parsed; } catch { throw new Error('Kontomappningen måste vara ett JSON-objekt, till exempel {"3010":"3000"}.'); } };
const optionsFrom = data => ({ mapping:mappingFrom(data.mapping), encoding:data.encoding==='utf8'?'utf8':'pc8', confirmed:data.confirmed==='on'||data.confirmed===true, anonymousConfirmed:data.anonymousConfirmed==='on'||data.anonymousConfirmed===true });

export function renderWorkspace(state) {
  const history = state.sieImports ?? [];
  const years = fiscalPeriods(state);
  return `<section class="sie-workspace"><header class="page-heading"><div><span class="eyebrow">IMPORT OCH EXPORT</span><h1>SIE · flytta din bokföring</h1><p>Läs in och exportera verifikationer och saldon i SIE 4. Granska bolag, år och konton innan något bokförs.</p></div></header>
  <div class="sie-columns"><article class="panel sie-panel"><h2>Exportera SIE 4</h2><p>En PC8-kodad fil med kontoplan, ingående och utgående saldon samt räkenskapsårets verifikationer. Ingen PDF, kundreskontra eller löneregister följer med.</p><form data-feature-form="sie" data-action="export"><label>Räkenskapsår<select name="year">${years.map(year=>`<option value="${e(yearKey(year))}" ${year.start===state.company.fiscalYearStart?'selected':''}>${e(year.start)}–${e(year.end)}</option>`).join('')}</select></label><button class="button primary" type="submit">Hämta SIE-fil</button></form><p class="sie-note">SIE 4C anger PC8 (IBM CP437). Typografiska citattecken och streck normaliseras. Andra tecken som inte kan representeras stoppas i stället för att tyst förstöras. <a href="${SIE_SPEC}" target="_blank" rel="noopener noreferrer">Läs formatspecifikationen ↗</a></p></article>
  <article class="panel sie-panel"><h2>Vad flyttas?</h2><p>Importen lägger till huvudboksverifikationer. Importerade verifikationsnummer bevaras som ursprungsreferens och får en egen plats i programmets löpande serie.</p><ul><li>Debet och kredit, datum, ingående balans och deklarerade slutsaldon kontrolleras.</li><li>Oförändrade tidigare importerade verifikationer hoppas över. Ändrade original stoppas.</li><li>Detaljerade reskontraposter, inventariekort och bilagor måste överföras separat.</li><li>Objektdimensioner och transaktionsdatum som skiljer sig från verifikationen stoppas tydligt.</li></ul></article></div>
  <article class="panel sie-panel"><h2>Importera och granska</h2><form data-feature-form="sie" data-action="import" id="sie-import-form"><div class="sie-columns"><label>Teckenkodning<select name="encoding" id="sie-encoding"><option value="pc8">PC8 · standard</option><option value="utf8">UTF-8 · välj uttryckligen för sådan fil</option></select></label><label>Välj fil<input type="file" accept=".se,.si,.sie,text/plain" id="sie-file"></label></div><p id="sie-file-status" role="status" class="sie-note"></p><label>SIE-innehåll<textarea name="sourceText" id="sie-source" rows="9" required maxlength="${SIE_LIMITS.bytes}" spellcheck="false" placeholder="#FLAGGA 0&#10;#PROGRAM …"></textarea></label><details><summary>Kontomappning</summary><p>Koppla konton som saknas till ett befintligt konto. Granska betydelsen, inte bara numret.</p><label>Mappning som JSON<textarea name="mapping" id="sie-mapping" rows="3" spellcheck="false">{}</textarea></label><p class="sie-note">Exempel: {"3010":"3000"}. Tillgängliga konton: ${ACCOUNTS.map(account=>e(account.number)).join(', ')}.</p></details><div class="sie-actions"><button type="button" class="button secondary" id="sie-preview">Granska import</button><button type="button" class="button secondary" id="sie-example">Fyll med ett fiktivt prov</button></div><div id="sie-preview-result" aria-live="polite"></div><p id="sie-preview-error" class="sie-error" role="alert" hidden></p><label class="sie-check"><input type="checkbox" name="confirmed" required> Jag har kontrollerat bolag, år, ingående balans och kontering.</label><label class="sie-check"><input type="checkbox" name="anonymousConfirmed"> Jag har även kontrollerat eventuella verifikationer utan serie/nummer mot tidigare filer.</label><button type="submit" class="button primary">Importera granskade verifikationer</button></form></article>
  <article class="panel sie-panel"><h2>Importerade filer</h2>${history.length?table(['Tidpunkt','Ursprung','Bokförda poster','Kvittens'],history.slice().reverse().map(batch=>[e(batch.importedAt.replace('T',' ').slice(0,16)),e(batch.fileHash.slice(0,12)),String(batch.items.length),`<button type="button" class="button secondary" data-feature-action="sie" data-action="receipt" data-id="${e(batch.id)}">Hämta kvittensfil</button>`])):'<p>Ingen SIE-fil har importerats ännu.</p>'}<p class="sie-note">Originalets innehåll och kontrollsumma följer importhistoriken. Kvittensfilen markerar #FLAGGA 1; källfilen raderas inte.</p></article></section>`;
}

export function handleAction(state, action, data) {
  if(action==='import') return importSie4(state,data.sourceText,optionsFrom(data));
  throw new Error('SIE-åtgärden stöds inte.');
}
export function getDownload(state, action, data) {
  if(action==='export') {
    const [start,end]=String(data.year||`${state.company.fiscalYearStart}/${state.company.fiscalYearEnd}`).split('/');
    return {name:`bokforing-${start}-${end}.se`,value:exportSie4(state,{start,end}),type:'application/octet-stream'};
  }
  if(action==='receipt') {
    const batch=(state.sieImports??[]).find(item=>item.id===data.id); if(!batch)throw new Error('Importen finns inte.');
    const text=batch.sourceText.split('\n').map(line=>/^\s*#FLAGGA\b/.test(line)?'#FLAGGA 1':line).join('\r\n');
    // Use the same real PC8 export encoding for the import acknowledgement.
    return {name:`sie-kvittens-${batch.fileHash.slice(0,12)}.si`,value:encodeReceipt(text),type:'application/octet-stream'};
  }
  return null;
}

export function mount(root, {getState} = {}) {
  const form=root.querySelector('#sie-import-form'); if(!form)return;
  const source=form.querySelector('#sie-source'), fileInput=form.querySelector('#sie-file'), encoding=form.querySelector('#sie-encoding');
  const status=form.querySelector('#sie-file-status'), result=form.querySelector('#sie-preview-result'), error=form.querySelector('#sie-preview-error');
  let generation=0;
  const changed=()=>{ generation++; result.replaceChildren(); error.hidden=true; };
  source.addEventListener('input',changed); form.querySelector('#sie-mapping').addEventListener('input',changed);
  const readFile=async()=>{
    const selected=fileInput.files?.[0]; if(!selected)return;
    source.value='';source.dispatchEvent(new Event('input',{bubbles:true}));
    const current=++generation;status.textContent='Läser fil…';
    try {
      if(selected.size>SIE_LIMITS.bytes)throw new Error('SIE-filen får vara högst 2 MB.');
      const bytes=await selected.arrayBuffer();
      if(!fileInput.isConnected||generation!==current)return;
      source.value=decodeSie(bytes,{encoding:encoding.value}); result.replaceChildren(); error.hidden=true;
      source.dispatchEvent(new Event('input',{bubbles:true})); status.textContent=`${selected.name} · ${selected.size} byte. Granska innehållet innan import.`;
    } catch(cause) { if(fileInput.isConnected&&generation===current){error.textContent=cause.message;error.hidden=false;status.textContent='Filen kunde inte läsas.';} }
  };
  fileInput.addEventListener('change',readFile);
  encoding.addEventListener('change',()=>{changed();if(fileInput.files?.length)readFile();});
  root.querySelector('#sie-preview').addEventListener('click',()=>{
    try {
      const values=Object.fromEntries(new FormData(form)), preview=previewSieImport(getState(),source.value,optionsFrom(values));
      result.innerHTML=`<div class="sie-preview"><h3>${e(preview.parsed.companyName)} · ${e(preview.year.start)}–${e(preview.year.end)}</h3><p><strong>${preview.freshCount}</strong> nya verifikationer · <strong>${preview.duplicateCount}</strong> kända dubbletter · debet/kredit ${e(money(preview.debitCents))}</p><p>Ingående balans: ${preview.includeOpening?'förs in med egen verifikation':preview.openingRows.length?'stämmer med befintlig ingående balans':'ingen ingående balans i filen'}.</p>${preview.warnings.length?`<ul>${preview.warnings.map(warning=>`<li>${e(warning)}</li>`).join('')}</ul>`:''}${table(['Ursprung','Datum','Beskrivning','Status'],preview.vouchers.slice(0,50).map(voucher=>[e(voucher.series+' '+voucher.number),e(voucher.date),e(voucher.description),voucher.duplicate?'Finns redan':'Ny']))}${preview.vouchers.length>50?'<p>De första 50 verifikationerna visas. Hela filen kontrolleras.</p>':''}</div>`;
      error.hidden=true;
    } catch(cause) { result.replaceChildren();error.textContent=cause.message;error.hidden=false; }
  });
  root.querySelector('#sie-example').addEventListener('click',()=>{
    const state=getState(), date=state.company.fiscalYearStart.replaceAll('-','');
    source.value=`#FLAGGA 0\n#PROGRAM "SIE Prov" "1.0"\n#FORMAT PC8\n#GEN ${date}\n#SIETYP 4\n#FNAMN "${state.company.name.replaceAll('"','')}"\n#RAR 0 ${date} ${state.company.fiscalYearEnd.replaceAll('-','')}\n#KONTO 6570 "Bankkostnader"\n#KONTO 1930 "Företagskonto"\n#VER "EXT" "1" ${date} "Fiktiv bankavgift"\n{\n#TRANS 6570 {} 123.40\n#TRANS 1930 {} -123.40\n}\n`;
    source.dispatchEvent(new Event('input',{bubbles:true})); status.textContent='Fiktivt prov. Ingen bokföring ändras förrän importen bekräftas.';
  });
}
