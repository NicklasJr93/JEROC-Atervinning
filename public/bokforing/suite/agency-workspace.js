// Presentation for the local agency demo. Access checks live in agency.js;
// changing the selected demo profile is not an authenticated login.
import { PERMISSIONS, getCompanyAccess, formatPersonalNumber, hasPermission } from './agency.js';
import { escapeHtml as e, icon } from './views.js';

const statusLabels = { pending: 'Väntar på svar', accepted: 'Kopplad', declined: 'Avböjd', revoked: 'Återkallad' };
const nameOf = (items, id, fallback = 'Okänd') => items.find(item => item.id === id)?.name || fallback;
const cleanName = name => String(name || '').replace(/\s*[·•]\s*demo(?:person)?$/i, '');
const permissionsOf = (directory, userId, companyId) => PERMISSIONS.filter(permission => hasPermission(directory, userId, companyId, permission.id));
const button = (label, action, id, kind = 'secondary', extra = '') => `<button type="button" class="button ${kind}" data-agency-action="${e(action)}" data-id="${e(id)}" ${extra}>${e(label)}</button>`;
const badge = status => `<span class="agency-status agency-status-${e(status)}">${e(statusLabels[status] || status)}</span>`;
const stamp = value => typeof value === 'string' ? value.slice(0, 16).replace('T', ' ') : '';

function permissionFields(selected = ['read'], suffix = 'invite') {
  return `<fieldset class="agency-permission-fields"><legend>Välj behörigheter</legend>${PERMISSIONS.map(permission => {
    const read = permission.id === 'read';
    return `<label class="agency-check" for="agency-permission-${e(suffix)}-${e(permission.id)}">${read ? '<input type="hidden" name="permissions" value="read">' : ''}<input id="agency-permission-${e(suffix)}-${e(permission.id)}" type="checkbox" name="${read ? 'readGranted' : 'permissions'}" value="${e(permission.id)}" ${read || selected.includes(permission.id) ? 'checked' : ''} ${read ? 'disabled' : ''}><span>${e(permission.label)}${read ? '<small>Ingår alltid i åtkomsten</small>' : ''}</span></label>`;
  }).join('')}</fieldset>`;
}

function permissionChips(permissions) {
  return `<div class="agency-permission-chips">${PERMISSIONS.filter(permission => permissions.includes(permission.id)).map(permission => `<span>${e(permission.label)}</span>`).join('')}</div>`;
}

function invitationCard(directory, invitation, { owner = false } = {}) {
  const company = nameOf(directory.companies, invitation.companyId, 'Bolaget');
  const person = cleanName(nameOf(directory.users, invitation.recipientId, 'Medarbetaren'));
  const agency = nameOf(directory.agencies, invitation.agencyId, 'Byrån');
  const headline = owner ? person : company;
  const subtitle = owner ? agency : `${cleanName(nameOf(directory.users, invitation.createdBy, 'Bolagsägaren'))} bjuder in dig via ${agency}`;
  let actions = '';
  if (invitation.status === 'pending') {
    actions = owner
      ? button('Återkalla inbjudan', 'cancel', invitation.id, 'secondary')
      : button('Acceptera inbjudan', 'accept', invitation.id, 'primary') + button('Avböj', 'decline', invitation.id);
  } else if (invitation.status === 'accepted' && owner) {
    actions = button('Återkalla åtkomst', 'revoke', invitation.id, 'danger');
  }
  const editable = owner && ['pending', 'accepted'].includes(invitation.status);
  return `<article class="agency-invitation" data-agency-invitation="${e(invitation.id)}"><header><div><h3>${e(headline)}</h3><p>${e(subtitle)}</p></div>${badge(invitation.status)}</header>${permissionChips(invitation.permissions)}${invitation.status === 'pending' ? `<p class="agency-help">${owner ? 'Ingen åtkomst ännu. Medarbetaren måste först acceptera inbjudan från sin demoprofil.' : 'När du accepterar kopplas ditt konto till bolaget med behörigheterna ovan.'}</p>` : ''}${editable ? `<details class="agency-edit"><summary>Ändra behörigheter</summary><form data-agency-form="permissions"><input type="hidden" name="invitationId" value="${e(invitation.id)}">${permissionFields(invitation.permissions, invitation.id)}<button class="button primary" type="submit">Spara behörigheter</button></form></details>` : ''}<footer><small>${invitation.status === 'pending' ? 'Inbjuden' : 'Senast ändrad'} ${e(stamp(invitation.updatedAt || invitation.createdAt))}</small><div class="agency-actions">${actions}</div></footer></article>`;
}

function demoDirectory(directory, user) {
  const people = directory.users.filter(person => person.agencyId && person.active !== false);
  return `<details class="agency-directory"><summary>Testpersoner att bjuda in <span>${people.length} registrerade demopersoner</span></summary><p>Numren nedan är fiktiva testnummer med framtida födelseår. Använd dem när du provar. Ange inga riktiga personuppgifter i demon.</p><ul>${people.map(person => `<li><div><strong>${e(cleanName(person.name))}</strong><small>${e(nameOf(directory.agencies, person.agencyId, 'Redovisningsbyrå'))}${user?.id === person.id ? ' · din demoprofil' : ''}</small></div><code>${e(formatPersonalNumber(person.personalNumber))}</code></li>`).join('')}</ul></details>`;
}

function companyCards(directory, userId, companyId) {
  const companies = getCompanyAccess(directory, userId);
  return `<section class="agency-panel" aria-labelledby="agency-companies-heading"><div class="agency-section-heading"><div><span class="agency-kicker">DIN ARBETSPLATS</span><h2 id="agency-companies-heading">Dina bolag</h2></div><span class="agency-count">${companies.length}</span></div>${companies.length ? `<div class="agency-company-grid">${companies.map(company => {
    const current = company.id === companyId;
    const owner = company.ownerId === userId;
    const rights = permissionsOf(directory, userId, company.id);
    return `<article class="agency-company-card ${current ? 'is-current' : ''}" data-agency-company="${e(company.id)}"><div class="agency-company-icon">${icon('ledger')}</div><div><span class="agency-kicker">${owner ? 'DU ÄGER BOLAGET' : 'BYRÅUPPDRAG'}</span><h3>${e(company.name)}</h3><p>${owner ? 'Ägare · samtliga behörigheter' : rights.map(permission => permission.label).join(' · ')}</p></div>${button(current ? 'Arbetar här' : 'Arbeta i bolaget', 'work', company.id, current ? 'secondary' : 'primary', current ? 'disabled aria-current="true"' : '')}</article>`;
  }).join('')}</div>` : '<div class="agency-empty"><div class="agency-empty-icon">' + icon('ledger') + '</div><h3>Inga kopplade bolag ännu</h3><p>Acceptera en inbjudan för att få ett bolag i din arbetslista. Du får bara de rättigheter bolagsägaren har valt.</p></div>'}</section>`;
}

function historyPanel(directory, userId, companyId) {
  const owner = directory.companies.some(company => company.id === companyId && company.ownerId === userId);
  const relevant = directory.activity.filter(event => {
    if (owner) return event.companyId === companyId;
    const invitation = directory.invitations.find(item => item.id === event.invitationId);
    return event.actorId === userId || event.recipientId === userId || invitation?.recipientId === userId;
  }).slice(-12).reverse();
  return `<section class="agency-panel agency-history" aria-labelledby="agency-history-heading"><div class="agency-section-heading"><div><span class="agency-kicker">SPÅRBARHET</span><h2 id="agency-history-heading">Åtkomsthistorik</h2></div></div>${relevant.length ? `<ol>${relevant.map(event => `<li><span class="agency-history-dot" aria-hidden="true"></span><div><strong>${e(event.label || 'Åtkomsten ändrades')}</strong><small>${e(cleanName(nameOf(directory.users, event.actorId, 'Demoperson')))}${event.companyId ? ` · ${e(nameOf(directory.companies, event.companyId, 'Bolaget'))}` : ''} · ${e(stamp(event.createdAt))}</small></div></li>`).join('')}</ol>` : '<p class="agency-help">När en inbjudan skapas, accepteras eller återkallas sparas händelsen här.</p>'}<p class="agency-footnote">Historiken finns kvar när åtkomst tas bort. Detta är lokal demohistorik, inte en serverbaserad revisionslogg.</p></section>`;
}

export function renderAgencyControls({ directory, userId, companyId }) {
  const user = directory.users.find(person => person.id === userId);
  const company = directory.companies.find(item => item.id === companyId);
  return `<div class="agency-controls"><label for="agency-demo-profile"><span>Demoperson</span><select id="agency-demo-profile" aria-label="Demoperson">${directory.users.filter(person => person.active !== false || person.id === userId).map(person => `<option value="${e(person.id)}" ${person.id === userId ? 'selected' : ''}>${e(cleanName(person.name))}${person.active === false ? ' · inaktiverad' : ''}</option>`).join('')}</select></label><a class="agency-context-link" href="#agency" title="Byt bolag eller hantera inbjudningar">${icon('payroll')}<span>${e(company?.name || (user?.agencyId ? nameOf(directory.agencies, user.agencyId, 'Byråöversikt') : 'Byråöversikt'))}</span></a></div>`;
}

export function renderAgencyWorkspace({ directory, userId, companyId, companyName, error = '' }) {
  const user = directory.users.find(person => person.id === userId);
  const company = directory.companies.find(item => item.id === companyId);
  const owner = Boolean(company && hasPermission(directory, userId, company.id, 'manage'));
  const ownInvites = directory.invitations.filter(invitation => invitation.recipientId === userId);
  const pending = ownInvites.filter(invitation => invitation.status === 'pending');
  const companyInvites = owner ? directory.invitations.filter(invitation => invitation.companyId === company.id) : [];
  const agencyName = user?.agencyId ? nameOf(directory.agencies, user.agencyId, 'Din byrå') : '';
  const activeCompanies = getCompanyAccess(directory, userId);
  const ownerContent = owner ? `<div class="agency-columns"><section class="agency-panel agency-invite-panel" aria-labelledby="agency-invite-heading"><div class="agency-section-heading"><div><span class="agency-kicker">${e(companyName || company.name)}</span><h2 id="agency-invite-heading">Bjud in en byråmedarbetare</h2></div><span class="agency-section-icon">${icon('plus')}</span></div><p>Ange personnumret för en registrerad demomedarbetare och välj vad personen får göra. Inbjudan hamnar hos rätt demoprofil.</p><form data-agency-form="invite" class="agency-invite-form"><label for="agency-personal-number">Personnummer<input id="agency-personal-number" name="personalNumber" type="text" inputmode="numeric" autocomplete="off" placeholder="ÅÅÅÅMMDD-NNNN" maxlength="17" required list="agency-demo-people" aria-describedby="agency-personal-number-help"></label><datalist id="agency-demo-people">${directory.users.filter(person => person.agencyId && person.active !== false).map(person => `<option value="${e(formatPersonalNumber(person.personalNumber))}">${e(cleanName(person.name))} · ${e(nameOf(directory.agencies, person.agencyId, 'Byrå'))}</option>`).join('')}</datalist><p class="agency-help" id="agency-personal-number-help">Använd ett av de fiktiva testnumren nedan. Inbjudan skickas bara om personen finns i byråregistret.</p>${permissionFields()}<button class="button primary" type="submit">${icon('plus')}Skapa inbjudan</button></form><div class="agency-info"><span>${icon('check')}</span><p>Åtkomst börjar först när mottagaren accepterar. Du kan ändra behörigheterna eller återkalla åtkomsten när som helst.</p></div></section><section class="agency-panel" aria-labelledby="agency-members-heading"><div class="agency-section-heading"><div><span class="agency-kicker">MEDARBETARE & INBJUDNINGAR</span><h2 id="agency-members-heading">Åtkomst till bolaget</h2></div><span class="agency-count">${companyInvites.filter(invitation => invitation.status === 'accepted').length} kopplade</span></div>${companyInvites.length ? `<div class="agency-invitation-list">${[...companyInvites].reverse().map(invitation => invitationCard(directory, invitation, { owner: true })).join('')}</div>` : '<div class="agency-empty"><div class="agency-empty-icon">' + icon('payroll') + '</div><h3>Du bestämmer vem som får hjälpa till</h3><p>Inbjudningar och kopplade byråmedarbetare visas här. Ingen annan har tillgång genom det här flödet ännu.</p></div>'}</section></div>` : '';
  const inbox = user?.agencyId ? `<section class="agency-panel agency-inbox" aria-labelledby="agency-inbox-heading"><div class="agency-section-heading"><div><span class="agency-kicker">${e(agencyName)}</span><h2 id="agency-inbox-heading">Dina inbjudningar</h2></div><span class="agency-count">${pending.length} väntar</span></div>${ownInvites.length ? `<div class="agency-invitation-list">${[...ownInvites].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending')).map(invitation => invitationCard(directory, invitation)).join('')}</div>` : '<div class="agency-empty"><div class="agency-empty-icon">' + icon('payroll') + '</div><h3>Du har inga inbjudningar ännu</h3><p>Prova flödet genom att välja Åke som demoperson, bjuda in dig med ditt testnummer och sedan växla tillbaka hit.</p></div>'}</section>` : '';
  return `<div class="agency-workspace"><header class="page-heading"><div><span class="eyebrow">ENDOR · SAMARBETE</span><h1>Byrå &amp; behörigheter</h1><p>${owner ? 'Ta hjälp med ekonomin och behåll kontrollen över åtkomsten.' : 'Samla dina kundbolag, svara på inbjudningar och välj var du vill arbeta.'}</p></div><div class="agency-profile-badge"><span>${icon(user?.agencyId ? 'payroll' : 'setup')}</span><div><strong>${e(cleanName(user?.name || 'Demoperson'))}</strong><small>${e(agencyName || 'Bolagsägare')}${companyId ? ` · ${e(companyName || company?.name || '')}` : ''}</small></div></div></header><div class="agency-demo-banner">${icon('sparkle')}<p><strong>Lokal demo</strong> · välj demoperson för att prova båda sidor. Inga inloggningar eller inbjudningsmejl skickas.</p></div>${error ? `<div class="agency-error" role="alert">${e(error)}</div>` : ''}<div class="agency-steps" aria-label="Så fungerar byrååtkomst"><div><span>1</span><p><strong>Bjud in</strong>Ägaren väljer person och behörigheter.</p></div><div><span>2</span><p><strong>Acceptera</strong>Medarbetaren svarar från sin profil.</p></div><div><span>3</span><p><strong>Arbeta tillsammans</strong>Bolaget visas bland medarbetarens uppdrag.</p></div></div>${ownerContent}${inbox}${companyCards(directory, userId, companyId)}${demoDirectory(directory, user)}${historyPanel(directory, userId, companyId)}<p class="agency-bottom-note">${activeCompanies.length ? 'Bolagets bokföring öppnas först när du väljer att arbeta i det.' : 'En väntande inbjudan ger ingen åtkomst till bokföringen.'} Personnumret används för att hitta en befintlig demoprofil; det verifierar inte identiteten.</p></div>`;
}
