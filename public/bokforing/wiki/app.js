import { wikiMeta, categories, articles } from './content.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('sv-SE');
const articleUrl = id => '#artikel/'+encodeURIComponent(id);
const statusLabels = { implemented:'Implementerat i demo', limited:'Avgränsat', planned:'Planerat', guide:'Guide' };
const categoryById = new Map(categories.map(category => [category.id, category]));
const articleById = new Map(articles.map(article => [article.id, article]));
const paths = {
  book:'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5z',
  search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  arrow:'M5 12h14m-5-5 5 5-5 5',
  shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zm-4 9 3 3 5-6',
  grid:'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  check:'m5 12 4 4L19 6',
  file:'M14 2H5v20h14V7zm0 0v5h5M8 12h8m-8 4h8',
  clock:'M12 7v5l3 2m7-2a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  menu:'M4 6h16M4 12h16M4 18h16',
  close:'m6 6 12 12M6 18 18 6',
  link:'m10 13 4-4m-7 6-2 2a4 4 0 0 0 6 6l3-3m-1-13 2-2a4 4 0 0 1 6 6l-3 3',
  external:'M14 3h7v7m0-7L10 14M10 5H4v15h15v-6',
  list:'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1',
};
const icon = (name='book') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.book}"></path></svg>`;
const date = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return escape(value || '');
  return new Intl.DateTimeFormat('sv-SE',{dateStyle:'long',timeZone:'Europe/Stockholm'}).format(new Date(value+'T12:00:00Z'));
};
const status = article => `<span class="status-pill ${escape(article.status)}">${escape(statusLabels[article.status] || article.status)}</span>`;
function safeUrl(value) {
  if (typeof value !== 'string') return '';
  if (/^\/bokforing(?:\/|$)/.test(value)) return value;
  try { const url=new URL(value);return url.protocol==='https:'&&url.hostname ? url.href : ''; } catch { return ''; }
}
function sourceLink(source, className='') {
  const url=safeUrl(source.url);
  return url ? `<a class="${escape(className)}" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(source.label)}${icon('external')}</a>` : `<span>${escape(source.label)}</span>`;
}
function searchable(article) {
  const sections=(article.sections || []).map(section => [section.title,...(section.paragraphs || []),...(section.bullets || []),...(section.steps || []),...(section.table?.headers || []),...(section.table?.rows || []).flat(),section.callout?.title,section.callout?.text].filter(Boolean).join(' ')).join(' ');
  return [article.title,article.summary,...(article.tags || []),sections,categoryById.get(article.category)?.title].join(' ');
}
const searchText = new Map(articles.map(article => [article.id,fold(searchable(article))]));
function readRoute() {
  const raw=location.hash.slice(1);
  if (raw.startsWith('artikel/')) {
    try { return {kind:'article',id:decodeURIComponent(raw.slice('artikel/'.length))}; } catch { return {kind:'missing'}; }
  }
  if (raw==='sok'||raw.startsWith('sok?')) {
    const parameters=new URLSearchParams(raw.split('?').slice(1).join('?'));
    const category=parameters.get('kategori') || '';
    return {kind:'search',query:parameters.get('q') || '',category:categoryById.has(category)?category:''};
  }
  return {kind:'home'};
}
function searchUrl(query='',category='') {
  const parameters=new URLSearchParams();
  if(query.trim())parameters.set('q',query.trim());
  if(category)parameters.set('kategori',category);
  const suffix=parameters.toString();return '#sok'+(suffix?'?'+suffix:'');
}
function go(hash) { if(location.hash===hash)render();else location.hash=hash; }
function findArticles(query,category='') {
  const words=fold(query).trim().split(/\s+/).filter(Boolean);
  return articles.filter(article => (!category || article.category===category) && words.every(word=>searchText.get(article.id).includes(word)))
    .map(article=>({article,score:words.reduce((sum,word)=>sum+(fold(article.title).includes(word)?10:0)+(fold(article.summary).includes(word)?3:0)+(fold((article.tags||[]).join(' ')).includes(word)?4:0),0)}))
    .sort((a,b)=>b.score-a.score||a.article.title.localeCompare(b.article.title,'sv')).map(item=>item.article);
}
function highlight(value,query) {
  const original=String(value || ''),term=fold(query).trim().split(/\s+/).find(Boolean);
  const index=term?fold(original).indexOf(term):-1;
  if(index<0)return escape(original);
  return escape(original.slice(0,index))+'<mark>'+escape(original.slice(index,index+term.length))+'</mark>'+escape(original.slice(index+term.length));
}
function snippet(article,query) {
  const summary=article.summary || '',words=fold(query).trim().split(/\s+/).filter(Boolean);
  if(!words.length||words.some(word=>fold(summary).includes(word)))return summary;
  const body=searchable(article),index=fold(body).indexOf(words[0]);
  if(index<0)return summary;
  const start=Math.max(0,index-60),end=Math.min(body.length,index+160);
  return (start?'…':'')+body.slice(start,end)+(end<body.length?'…':'');
}
function searchForm(query='',locationName='main') {
  return `<form class="${locationName==='hero'?'hero-search':locationName==='top'?'topbar-search':'search-form'}" data-wiki-search role="search"><label class="sr-only" for="wiki-search-${locationName}">Sök i bokföringswikin</label>${icon('search')}<input id="wiki-search-${locationName}" name="q" value="${escape(query)}" placeholder="Sök funktion, kontroll eller arbetsflöde…" type="search" autocomplete="off" maxlength="300"><button type="submit" ${locationName==='top'?'aria-label="Sök i wikin"':''}>${locationName==='top'?icon('arrow'):'Sök i wikin'}</button></form>`;
}
function sidebar(route) {
  const selected=route.kind==='article'?articleById.get(route.id):null;
  return `<a href="#" class="wiki-brand"><span class="brand-icon">${icon('book')}</span><span><strong>Bokföringswikin</strong><small>en del av ScrapPlanner</small></span></a>
    <p class="side-label">KUNSKAPSBANK</p><a href="#" class="side-home ${route.kind==='home'?'active':''}" ${route.kind==='home'?'aria-current="page"':''}>${icon('grid')}Översikt</a>
    <a href="#sok" class="side-home ${route.kind==='search'?'active':''}" ${route.kind==='search'?'aria-current="page"':''}>${icon('search')}Alla artiklar<span>${articles.length}</span></a>
    <nav aria-label="Wikiartiklar">${categories.map(category=>`<details class="side-group" ${selected?.category===category.id||route.category===category.id?'open':''}><summary>${escape(category.title)}<span>${articles.filter(article=>article.category===category.id).length}</span></summary><div>${articles.filter(article=>article.category===category.id).map(article=>`<a href="${articleUrl(article.id)}" class="${selected?.id===article.id?'active':''}" ${selected?.id===article.id?'aria-current="page"':''}>${escape(article.title)}</a>`).join('')}</div></details>`).join('')}</nav>
    <div class="side-footer"><span class="side-label">DOKUMENTERAD VERSION</span><strong>${escape(wikiMeta.version || '920a135')}</strong><p>Funktioner, gränser och testbevis för bokföringsdemon.</p><a href="/bokforing/">${icon('arrow')}Till bokföringsdemon</a></div>`;
}
function chosen(ids) {return ids.map(id=>articleById.get(id)).filter(Boolean);}
function home() {
  const recommended=chosen(['for-revisorn','omfattning','verifiering']);
  const release=chosen(['andringar','leverantorsfakturor','underlagsinkorg']);
  const stats=wikiMeta.verification || {model:211,http:1,browser:49};
  return `<section class="wiki-hero"><div class="hero-copy"><p class="eyebrow">DOKUMENTATION · BOKFÖRING</p><h1>Förstå systemet.<br>Följ varje kontroll.</h1><p class="hero-lead">Här samlar vi hur bokföringsdemon fungerar, vad som är byggt och vad som återstår. För dig som använder, utvecklar eller granskar.</p>${searchForm('','hero')}<div class="hero-chips"><span>${icon('book')}${articles.length} sökbara artiklar</span><span>${icon('shield')}Kontroller med källhänvisningar</span><span>${icon('clock')}Uppdaterad ${date(wikiMeta.asOf)}</span></div></div><aside class="hero-version"><span class="hero-emblem">${icon('shield')}</span><p class="eyebrow">FÖR DIG SOM GRANSKAR</p><h2>En tydlig väg genom demon</h2><p>Börja med omfattningen, följ kontrollernas syfte och öppna sedan källkod och tester.</p><a href="${articleUrl('for-revisorn')}" class="button primary">Öppna granskningsguiden ${icon('arrow')}</a><small>Dokumentation av demo · inget revisionsutlåtande</small></aside></section>
    <div class="home-grid"><div><section class="knowledge-section"><div class="section-heading"><div><p class="eyebrow">HITTA RÄTT</p><h2>Vad vill du veta mer om?</h2></div><a href="#sok">Alla artiklar ${icon('arrow')}</a></div><div class="topic-grid">${categories.map((category,index)=>`<a class="topic-card" href="${searchUrl('',category.id)}"><span class="topic-icon tone-${index%4}">${icon(['book','grid','shield','file','check','clock'][index%6])}</span><h3>${escape(category.title)}</h3><p>${escape(category.description || '')}</p><span class="topic-meta">${articles.filter(article=>article.category===category.id).length} artiklar ${icon('arrow')}</span></a>`).join('')}</div></section>
      <section class="knowledge-section"><div class="section-heading"><div><p class="eyebrow">REKOMMENDERAD LÄSNING</p><h2>Börja här som revisor</h2></div>${icon('list')}</div><div class="reading-list">${recommended.map((article,index)=>`<a href="${articleUrl(article.id)}"><span class="step-number">0${index+1}</span><div class="reading-copy"><h3>${escape(article.title)}</h3><p>${escape(article.summary)}</p></div>${icon('arrow')}</a>`).join('')}</div></section>
    </div><aside class="home-aside"><section class="version-card"><p class="eyebrow">DOKUMENTERAD DEMOVERSION</p><h2>${escape(wikiMeta.version)}</h2><p>Underlaget beskriver kodversionen från ${date(wikiMeta.asOf)}.</p><div class="version-stats"><div class="version-stat"><strong>${escape(stats.model)}</strong><span>modell- och<br>lagringstester</span></div><div class="version-stat"><strong>${escape(stats.browser)}</strong><span>webbläsar-<br>prov</span></div><div class="version-stat"><strong>${escape(stats.http)}</strong><span>HTTP-<br>integrationstest</span></div></div><p class="inline-note">Testresultaten gäller beskrivna demofall. De intygar inte full regelefterlevnad eller produktionsberedskap.</p><a href="${articleUrl('verifiering')}">Se vad som verifierats ${icon('arrow')}</a></section>
    <section class="version-card recent-card"><p class="eyebrow">AKTUELLT I DOKUMENTATIONEN</p><h2>Senaste utbyggnaden</h2><div class="update-list">${release.map(article=>`<a href="${articleUrl(article.id)}"><span class="update-dot"></span><div><strong>${escape(article.title)}</strong><small>${escape(article.summary)}</small></div>${icon('arrow')}</a>`).join('')}</div></section>
    <div class="inline-note home-note">${icon('file')}<div><strong>En gemensam kunskapsbank</strong><p>Wikin läser inga fakturor eller företagsuppgifter. Samma dokumentation kan öppnas av alla som har länken.</p></div></div></aside></div>`;
}
function sectionBody(section) {
  return `${(section.paragraphs||[]).map(paragraph=>`<p>${escape(paragraph)}</p>`).join('')}${section.bullets?.length?`<ul>${section.bullets.map(item=>`<li>${escape(item)}</li>`).join('')}</ul>`:''}${section.steps?.length?`<ol>${section.steps.map(item=>`<li>${escape(item)}</li>`).join('')}</ol>`:''}${section.table?`<div class="table-scroll"><table><thead><tr>${section.table.headers.map(header=>`<th scope="col">${escape(header)}</th>`).join('')}</tr></thead><tbody>${section.table.rows.map(row=>`<tr>${row.map(cell=>`<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:''}${section.callout?`<aside class="callout ${['warning','success'].includes(section.callout.tone)?section.callout.tone:'info'}">${icon(section.callout.tone==='warning'?'file':'shield')}<div><strong>${escape(section.callout.title)}</strong><p>${escape(section.callout.text)}</p></div></aside>`:''}`;
}
function articlePage(article) {
  const category=categoryById.get(article.category);
  const related=chosen(article.related || []);
  return `<nav class="breadcrumb" aria-label="Brödsmulor"><a href="#">Wikin</a><span>/</span><a href="${searchUrl('',article.category)}">${escape(category?.title || 'Artiklar')}</a></nav><div class="article-layout"><article>
    <header class="article-header"><p class="eyebrow">${escape(category?.title || 'DOKUMENTATION')}</p><h1>${escape(article.title)}</h1><p class="article-summary">${escape(article.summary)}</p><div class="article-meta">${status(article)}<span>${icon('clock')}${date(article.updated)}</span><span>Demoversion ${escape(wikiMeta.version)}</span><button type="button" class="copy-link" data-copy-link>${icon('link')}Kopiera länk</button></div></header>
    <div class="article-body">${(article.sections || []).map((section,index)=>`<section id="wiki-section-${index}" data-section-id="${escape(section.id || String(index))}"><h2>${escape(section.title)}</h2>${sectionBody(section)}</section>`).join('')}</div>
    ${article.sources?.length?`<section class="sources-card"><div><span class="topic-icon">${icon('file')}</span><h2>Källor och fördjupning</h2></div><p>Följ beskrivningen till koden, testerna eller regelunderlaget.</p><ul>${article.sources.map(source=>`<li>${sourceLink(source)}</li>`).join('')}</ul></section>`:''}
    ${related.length?`<section class="related-section"><div class="section-heading"><h2>Läs vidare</h2></div><div class="related-grid">${related.map(item=>`<a class="related-card" href="${articleUrl(item.id)}">${status(item)}<h3>${escape(item.title)}</h3><p>${escape(item.summary)}</p><span>Öppna artikel ${icon('arrow')}</span></a>`).join('')}</div></section>`:''}
    </article><aside class="article-toc"><p class="eyebrow">PÅ DEN HÄR SIDAN</p><nav aria-label="Artikelns innehåll">${(article.sections || []).map((section,index)=>`<a href="#wiki-section-${index}" data-wiki-section="${index}">${escape(section.title)}</a>`).join('')}${article.sources?.length?'<a href="#sources" data-scroll-sources>Källor och fördjupning</a>':''}</nav><div class="toc-version">${icon('shield')}<strong>Tydliga avgränsningar</strong><p>Statusen beskriver vad som finns i denna demo. Läs alltid artikelns omfattning och kvarstående arbete.</p><a href="${articleUrl('kanda-begransningar')}">Kända begränsningar ${icon('arrow')}</a></div></aside></div>`;
}
function searchPage(route) {
  const results=findArticles(route.query,route.category);
  const category=categoryById.get(route.category);
  return `<nav class="breadcrumb" aria-label="Brödsmulor"><a href="#">Wikin</a><span>/</span><span>Sök och bläddra</span></nav><header class="search-heading"><p class="eyebrow">SÖK I KUNSKAPSBANKEN</p><h1>${escape(category?.title || 'Alla artiklar')}</h1><p>Hitta arbetsflöden, systemkontroller och underlag för din granskning.</p>${searchForm(route.query)}</header><div class="filter-bar" aria-label="Filtrera på område"><button type="button" data-category-filter="all" class="${route.category?'':'active'}" aria-pressed="${!route.category}">Alla områden</button>${categories.map(item=>`<button type="button" data-category-filter="${escape(item.id)}" class="${route.category===item.id?'active':''}" aria-pressed="${route.category===item.id}">${escape(item.title)}</button>`).join('')}</div><p class="result-count" role="status">${results.length} ${results.length===1?'artikel':'artiklar'}${route.query?' för ”'+escape(route.query)+'”':''}${category?' inom '+escape(category.title):''}</p><div class="search-results">${results.length?results.map(article=>`<a class="result-card" href="${articleUrl(article.id)}"><div class="result-top"><span>${escape(categoryById.get(article.category)?.title || '')}</span>${status(article)}</div><h2>${highlight(article.title,route.query)}</h2><p>${highlight(snippet(article,route.query),route.query)}</p><div class="result-bottom"><span>${(article.tags||[]).slice(0,3).map(tag=>`<span>${escape(tag)}</span>`).join('')}</span>${icon('arrow')}</div></a>`).join(''):`<div class="empty-state">${icon('search')}<h2>Ingen artikel matchar din sökning</h2><p>Prova ett annat ord, till exempel faktura, ROT, underlag eller rättelse. Du kan också ta bort områdesfiltret.</p><a href="#sok" class="button secondary">Visa alla artiklar ${icon('arrow')}</a></div>`}</div>`;
}
function missing() {return `<div class="empty-state">${icon('book')}<p class="eyebrow">SIDAN HITTADES INTE</p><h1>Den artikeln finns inte här</h1><p>Öppna översikten eller sök efter ämnet för att hitta rätt.</p><a class="button primary" href="#">Till wikiöversikten ${icon('arrow')}</a></div>`;}

document.querySelector('#wiki-app').innerHTML=`<div class="wiki-shell"><button id="wiki-backdrop" aria-label="Stäng menyn" hidden></button><aside id="wiki-sidebar"></aside><div class="wiki-workspace"><header class="wiki-topbar"><button id="wiki-menu" class="icon-button" aria-label="Öppna wikimenyn" aria-expanded="false" aria-controls="wiki-sidebar">${icon('menu')}</button><div class="topbar-title">Kunskapsbank <span>/</span> Bokföring</div>${searchForm('','top')}<div class="topbar-actions"><span class="topbar-demo">DEMODOKUMENTATION</span><a class="button secondary" href="/bokforing/">Öppna demon ${icon('external')}</a></div></header><main id="wiki-main" tabindex="-1"></main><footer class="wiki-footer"><span>ScrapPlanner · Bokföringswikin</span><span>Dokumenterar version ${escape(wikiMeta.version)} · ${date(wikiMeta.asOf)}</span><a href="${articleUrl('kanda-begransningar')}">Omfattning och begränsningar</a></footer></div></div><div id="wiki-toast" role="status" hidden></div>`;
const main=document.querySelector('#wiki-main'), side=document.querySelector('#wiki-sidebar');
const mobileNavigation=matchMedia('(max-width: 800px)');
let toastTimer;
function notify(message) {const toast=document.querySelector('#wiki-toast');toast.textContent=message;toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true;},4500);}
function closeMenu(restoreFocus=false) {
  side.classList.remove('open');side.inert=mobileNavigation.matches;
  if(mobileNavigation.matches)side.setAttribute('aria-hidden','true');else side.removeAttribute('aria-hidden');
  side.removeAttribute('aria-modal');side.removeAttribute('role');
  document.querySelector('#wiki-backdrop').hidden=true;document.querySelector('#wiki-menu').setAttribute('aria-expanded','false');
  if(restoreFocus)document.querySelector('#wiki-menu').focus();
}
function render({focus=true}={}) {
  const route=readRoute(),article=route.kind==='article'?articleById.get(route.id):null;
  side.innerHTML=sidebar(route);
  main.innerHTML=route.kind==='home'?home():route.kind==='search'?searchPage(route):article?articlePage(article):missing();
  const query=document.querySelector('#wiki-search-top');query.value=route.query || '';
  document.title=(article?article.title:route.kind==='search'?'Sök i wikin':'Bokföringswikin')+' · ScrapPlanner';
  closeMenu();
  if(focus){window.scrollTo(0,0);main.focus({preventScroll:true});}
}
document.addEventListener('submit',event=>{
  if(!event.target.matches('[data-wiki-search]'))return;
  event.preventDefault();const route=readRoute();go(searchUrl(new FormData(event.target).get('q') || '',route.kind==='search'?route.category:''));
});
document.addEventListener('click',async event=>{
  const skip=event.target.closest('.skip-link');if(skip){event.preventDefault();main.focus();return;}
  const filter=event.target.closest('[data-category-filter]');if(filter){const route=readRoute();go(searchUrl(route.query || '',filter.dataset.categoryFilter==='all'?'':filter.dataset.categoryFilter));return;}
  const section=event.target.closest('[data-wiki-section]');if(section){event.preventDefault();const target=document.getElementById('wiki-section-'+section.dataset.wikiSection);if(target){target.setAttribute('tabindex','-1');target.focus({preventScroll:true});target.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}return;}
  if(event.target.closest('[data-scroll-sources]')){event.preventDefault();document.querySelector('.sources-card')?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});return;}
  if(event.target.closest('[data-copy-link]')){try{await navigator.clipboard.writeText(location.href);notify('Länken till artikeln är kopierad.');}catch{notify('Länken kunde inte kopieras. Kopiera adressen i webbläsarens adressfält.');}return;}
  if(event.target.closest('#wiki-menu')){
    if(side.classList.contains('open'))closeMenu(true);
    else{side.classList.add('open');side.inert=false;side.removeAttribute('aria-hidden');if(mobileNavigation.matches){side.setAttribute('role','dialog');side.setAttribute('aria-modal','true');side.setAttribute('aria-label','Wikimenyn');}document.querySelector('#wiki-backdrop').hidden=false;document.querySelector('#wiki-menu').setAttribute('aria-expanded','true');side.querySelector('a')?.focus();}
    return;
  }
  if(event.target.closest('#wiki-backdrop'))closeMenu(true);
});
document.addEventListener('keydown',event=>{
  if(!side.classList.contains('open')||!mobileNavigation.matches)return;
  if(event.key==='Escape'){closeMenu(true);return;}
  if(event.key==='Tab'){
    const focusable=[...side.querySelectorAll('a,button,summary,input,[tabindex="0"]')].filter(element=>element.getClientRects().length);
    const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
});
mobileNavigation.addEventListener('change',()=>closeMenu());
window.addEventListener('hashchange',()=>render());
render({focus:false});
