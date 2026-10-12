(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = (name, size=18) => window.icon(name,size);
  const pill = (text,tone='blue') => `<span class="pill ${esc(tone)}">${esc(text)}</span>`;
  const money = value => Number(value).toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' kr';
  const stat = (label,value,note,iconName='Scale',tone='blue') => `<section class="stat"><span class="stat-icon ${esc(tone)}">${icon(iconName,20)}</span><div><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div></section>`;
  const task = ({title,detail,label='Öppna',type='case',id='',tone='blue'}) => `<article class="task"><span class="task-icon ${esc(tone)}">${icon(tone==='amber'?'CircleAlert':tone==='green'?'CircleCheck':'ClipboardCheck',19)}</span><div><strong>${esc(title)}</strong><p>${esc(detail)}</p></div><button type="button" class="button ${tone==='amber'?'outline':'soft'}" data-case="${esc(type)}" data-case-id="${esc(id)}">${esc(label)}${icon('ChevronRight',14)}</button></article>`;
  window.MockupUI={esc,icon,pill,money,stat,task};
})();
