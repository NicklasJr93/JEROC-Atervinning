document.documentElement.classList.add('js');

const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#main-nav');
function setMenu(open) {
  if (!menu || !navigation) return;
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Stäng menyn' : 'Öppna menyn');
  navigation.classList.toggle('is-open', open);
}
menu?.addEventListener('click', (event) => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  setMenu(open);
  if (open && event.detail === 0) navigation.querySelector('a')?.focus();
});
navigation?.addEventListener('click', (event) => {
  if (event.target.closest('a')) setMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Escape' &&
    menu?.getAttribute('aria-expanded') === 'true'
  ) {
    setMenu(false);
    menu.focus();
  }
});
window.matchMedia('(min-width: 1001px)').addEventListener('change', (event) => {
  if (event.matches) setMenu(false);
});

const form = document.querySelector('#demo-form');
if (form) {
  form.hidden = false;
  const result = document.querySelector('#enquiry-result');
  const output = document.querySelector('#enquiry-text');
  const status = document.querySelector('#form-status');
  const emailLink = document.querySelector('#email-enquiry');
  const recipient = form.dataset.recipient ?? '';
  const topic = new URLSearchParams(location.search).get('amne');
  if (topic === 'offert') {
    form.elements.message.value =
      'Hej! Vi vill gärna få en offert och en genomgång av ScrapPlanner.\n\nOm vår verksamhet: ';
  } else if (topic === 'nvv') {
    form.elements.message.value =
      'Hej! Vi vill veta mer om kopplingen till Naturvårdsverkets avfallsregister och förutsättningarna för vår verksamhet.\n\nOm vårt rapporteringsbehov: ';
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const company = String(data.get('company') ?? '').trim();
    const email = String(data.get('email') ?? '').trim();
    const message = String(data.get('message') ?? '').trim();
    if (!name || !company || !email || message.length < 10) {
      status.textContent =
        'Fyll i namn, företag, e-postadress och minst tio tecken om ert behov.';
      return;
    }
    const text = `Hej ScrapPlanner!\n\n${message}\n\nFöretag: ${company}\nKontaktperson: ${name}\nE-post: ${email}`;
    output.value = text;
    if (recipient && emailLink) {
      emailLink.href = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent('Demoförfrågan – ScrapPlanner')}&body=${encodeURIComponent(text)}`;
      emailLink.hidden = false;
    }
    result.hidden = false;
    status.textContent =
      'Förfrågan är förberedd. Inget har skickats. Öppna mejlet eller kopiera texten nedan.';
    result.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'center',
    });
    const title = document.querySelector('#enquiry-result-title');
    title.setAttribute('tabindex', '-1');
    title.focus({ preventScroll: true });
  });
  document
    .querySelector('#copy-enquiry')
    ?.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText)
          throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(output.value);
        status.textContent =
          'Förfrågan har kopierats. Klistra in den i ditt mejl och skicka när du är redo.';
      } catch {
        output.focus();
        output.select();
        status.textContent =
          'Texten är markerad. Välj Kopiera i din webbläsare och klistra sedan in den i ett mejl.';
      }
    });
}
