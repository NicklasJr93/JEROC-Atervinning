import PDFDocument from 'pdfkit';
import { readFileSync, mkdirSync, createWriteStream, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/build-bokforing-audit-pdf.mjs report.json report.pdf');
const report = JSON.parse(readFileSync(input, 'utf8'));
mkdirSync(dirname(output), { recursive: true });
const pdf = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true, info: {
  Title: 'ScrapPlanner – teknisk testgranskning och redovisningsrisker',
  Author: 'ScrapPlanner – tekniskt granskningsunderlag',
  Subject: `Testad kodversion ${report.revision}; underlag till extern redovisningsgranskning`,
  Keywords: 'bokföring, redovisning, testprotokoll, regelgranskning, demo',
}});
const stream = createWriteStream(output); pdf.pipe(stream);
const fontRoot = process.env.BOKFORING_REPORT_FONT_DIR || '/usr/share/fonts/opentype/urw-base35';
const regular = existsSync(`${fontRoot}/NimbusSans-Regular.otf`) ? 'ReportRegular' : 'Helvetica';
const boldFont = existsSync(`${fontRoot}/NimbusSans-Bold.otf`) ? 'ReportBold' : 'Helvetica-Bold';
if (regular === 'ReportRegular') pdf.registerFont(regular, `${fontRoot}/NimbusSans-Regular.otf`);
if (boldFont === 'ReportBold') pdf.registerFont(boldFont, `${fontRoot}/NimbusSans-Bold.otf`);
const color = { ink:'#142B45', muted:'#546579', blue:'#245CC5', green:'#147963', amber:'#9A5B05', red:'#A52F39', line:'#D9E1E9', pale:'#F1F5F9' };
const left = 44, width = 507, bottom = 760;
let y = 44;
function page(label) {
  if (pdf.bufferedPageRange().count) pdf.addPage();
  pdf.fillColor(color.ink).font(boldFont).fontSize(9).text('SCRAPPLANNER', left, 34);
  pdf.fillColor(color.muted).font(regular).fontSize(8).text(label || 'Tekniskt granskningsunderlag', left + 120, 35, { width: width - 120, align:'right' });
  pdf.moveTo(left, 54).lineTo(left + width, 54).strokeColor(color.line).stroke(); y = 74;
}
function room(height) { if (y + height > bottom) page(); }
function text(value, { size=10.5, bold=false, fill=color.ink, gap=8, indent=0 }={}) {
  pdf.font(bold?boldFont:regular).fontSize(size);
  const h = pdf.heightOfString(String(value), { width:width-indent, lineGap:2.5 }); room(h + gap);
  pdf.fillColor(fill).text(String(value),left+indent,y,{width:width-indent,lineGap:2.5}); y+=h+gap;
}
function title(value, subtitle) {
  text(value,{size:22,bold:true,gap:12}); if(subtitle)text(subtitle,{size:11.5,fill:color.muted,gap:17});
}
function heading(value) { room(36); text(value,{size:14,bold:true,gap:10}); }
function bullet(value) {
  pdf.font(regular).fontSize(10.5); const h=pdf.heightOfString(value,{width:width-15,lineGap:2.5});room(h+8);
  pdf.circle(left+3,y+5,2).fill(color.blue);text(value,{indent:15});
}
function link(label,url) {
  text(label,{bold:true,size:10,gap:4});
  pdf.font(regular).fontSize(8.5);const h=pdf.heightOfString(url,{width,lineGap:2});room(h+12);
  pdf.fillColor(color.blue).text(url,left,y,{width,lineGap:2,link:url,underline:false});y+=h+12;
}
function table(headers, rows, widths) {
  const draw=(cells,header,index)=>{
    pdf.font(header?boldFont:regular).fontSize(header?9:9.2);
    const h=Math.max(...cells.map((cell,i)=>pdf.heightOfString(String(cell),{width:widths[i]-14,lineGap:2})))+16;
    if(y+h>bottom){page();draw(headers,true,0);}
    pdf.rect(left,y,width,h).fill(header?color.ink:index%2?color.pale:'#FFFFFF');
    let x=left;
    cells.forEach((cell,i)=>{pdf.fillColor(header?'#FFFFFF':color.ink).text(String(cell),x+7,y+8,{width:widths[i]-14,lineGap:2});x+=widths[i];});
    y+=h;pdf.moveTo(left,y).lineTo(left+width,y).strokeColor(color.line).stroke();
  };
  draw(headers,true,0);rows.forEach((row,i)=>draw(row,false,i));y+=14;
}
function cards(items) {
  room(95);const gap=12,w=(width-2*gap)/3;
  items.forEach(([value,label],i)=>{const x=left+i*(w+gap);pdf.roundedRect(x,y,w,82,6).fill(color.pale);pdf.fillColor(color.ink).font(boldFont).fontSize(26).text(String(value),x+12,y+13,{width:w-24});pdf.fillColor(color.muted).font(regular).fontSize(9).text(label,x+12,y+49,{width:w-24,lineGap:2});});y+=101;
}
function blockHeight(value, size=10, bold=false, gap=8) {
  pdf.font(bold?boldFont:regular).fontSize(size);
  return pdf.heightOfString(String(value),{width,lineGap:2.5})+gap;
}
function finding(item) {
  room(blockHeight(`${item.id}  |  ${item.severity}  |  ${item.status}`,9,true,5)
    +blockHeight(item.title,12,true,7)
    +blockHeight(`Utlösande situation: ${item.trigger}`)
    +blockHeight(`Före rättning: ${item.before}`)
    +blockHeight(`Åtgärd: ${item.after}`)
    +blockHeight(`Testbevis: ${item.tests}`,9,false,17));text(`${item.id}  |  ${item.severity}  |  ${item.status}`,{size:9,bold:true,fill:item.status==='Rättat'?color.green:color.red,gap:5});
  text(item.title,{size:12,bold:true,gap:7});
  text(`Utlösande situation: ${item.trigger}`,{size:10});
  text(`Före rättning: ${item.before}`,{size:10});
  text(`Åtgärd: ${item.after}`,{size:10});
  text(`Testbevis: ${item.tests}`,{size:9,fill:color.muted,gap:17});
}

// The cover is the document's initial page.
pdf.fillColor(color.ink).rect(0,0,595.28,13).fill();
y=48;text('SCRAPPLANNER / BOKFÖRING',{size:10,bold:true,fill:color.blue,gap:24});
title('Teknisk testgranskning\noch redovisningsrisker','Underlag till extern redovisningskonsult eller revisor');
text(`Granskningsdatum: ${report.date}\nTestad kod: ${report.revision}\nUtgångsversion: ${report.baseline}`,{size:9.5,fill:color.muted,gap:20});
cards([[report.tests.newPassed,'nya varierade auditfall'],[report.tests.totalPassed,'godkända automatiska tester'],[report.findings.length,'fynd med rättning eller skydd']]);
heading('Samlad bedömning');
text(report.conclusion,{size:12,bold:true,gap:14});
for(const item of report.summary)bullet(item);
text('Rapporten är framtagen med AI-stöd genom kodgranskning, automatiska tester och kontroller av angivna källor. Den är inte utfärdad av Skatteverket, Bokföringsnämnden eller en auktoriserad revisor och utgör inget bestyrkande.',{size:9,fill:color.muted,gap:18});
link('Prova den fiktiva demonstrationen',report.demoUrl);

page('Uppdrag, avgränsning och testmetod');title('Vad granskningen omfattar');
for(const paragraph of report.method)text(paragraph);
page('Omfattning och resultat');title('Testresultat och testområden');
table(['Område','Nya fall','Kontroll / scenario'],report.domains.map(d=>[d.label,d.count,d.description]),[132,54,321]);
text(`Testkörning: ${report.tests.startedAt}–${report.tests.finishedAt}. Resultat: ${report.tests.totalPassed} godkända, ${report.tests.failed} underkända, ${report.tests.skipped} överhoppade. Alla nya auditfall har ett eget identifierbart testnamn.`,{size:9.5,fill:color.muted});
if (report.browser) text(report.browser.summary,{size:10});
text('Ett godkänt test kan bekräfta att ett ogiltigt försök stoppas, att rätt belopp bokförs eller att en känd begränsning finns. Antalet godkända tester är därför inte ett antal godkända lagkrav.',{bold:true,size:10});

page('Fynd och genomförda åtgärder');title('Åtgärdade fynd med spårbara testbevis');
text('Följande fel kunde återskapas mot den tidigare koden. Rättningar och regressionstester ingår i den testade versionen. Allvarlighetsgraden beskriver den tekniska/redovisningsmässiga följden i det prövade fallet.');
for(const item of report.findings)finding(item);

page('Regelkrav och bedömning');title('Kravmatris för extern sakgranskning');
text('Statusarna avser den avgränsade demonstrationen. ”Tekniskt prövat” betyder att angivna kontroller fungerar i testfallen; rätt affärsklassificering, komplett underlag och verklig efterlevnad måste bedömas separat.');
table(['Krav / stöd','Iakttagelse och status','Källa'],report.compliance.map(r=>[r.requirement,r.assessment,r.source]),[125,287,95]);

page('Kvarstående risker och åtgärder');title('Vad som fortfarande behöver lösas');
text('Nedanstående punkter ska följas upp innan systemet används som ett företags skarpa bokföring. Att lagring och inloggning har skjutits till en senare etapp förändrar inte kraven på den färdiga driften.');
for(const gap of report.gaps){room(82);text(`${gap.id}  |  ${gap.priority}`,{size:9,bold:true,fill:gap.priority.startsWith('Hög')?color.red:color.amber,gap:5});text(gap.title,{size:12,bold:true,gap:6});text(gap.detail,{size:10});text(`Nästa kontroll/åtgärd: ${gap.action}`,{size:10,fill:color.muted,gap:17});}

page('Granskarens checklista');title('Förslag till redovisarens granskning');
text('Använd fiktiva uppgifter vid första genomgången. Följ varje händelse från underlag till reskontra, verifikation, moms/lön, rapport och eventuell rättelse. Dokumentera avvikelser med test-ID eller faktura-/verifikationsreferens.');
report.reviewerChecklist.forEach((item,i)=>{pdf.font(regular).fontSize(10.3);const h=pdf.heightOfString(item,{width:width-23,lineGap:3});room(h+17);pdf.rect(left,y+2,9,9).strokeColor(color.muted).stroke();text(`${i+1}. ${item}`,{size:10.3,indent:23,gap:13});});
room(135);heading('Granskningsanteckning');
for(const label of ['Namn / organisation:', 'Datum / granskad kodversion:', 'Avvikelser / villkor för nästa etapp:']){text(label,{size:9,fill:color.muted,gap:17});pdf.moveTo(left,y).lineTo(left+width,y).strokeColor(color.line).stroke();y+=16;}

page('Källor, versioner och reproducerbarhet');title('Källförteckning');
text('Källorna kontrollerades i samband med granskningen. Angivna lagrum och formatversioner avser de frågor som faktiskt undersökts, inte en genomgång av all svensk redovisnings- och skattelagstiftning.');
for(const source of report.sources){
  pdf.font(regular).fontSize(8.5);
  const urlHeight=pdf.heightOfString(source.url,{width,lineGap:2})+12;
  room(blockHeight(`${source.id}. ${source.title}`,10,true,4)+urlHeight+blockHeight(source.detail,9,false,15));
  link(`${source.id}. ${source.title}`,source.url);text(source.detail,{size:9,fill:color.muted,gap:15});}
page('Kodversion och reproducerbarhet');title('Så följs testbevisen till koden');
link('Testad kodversion',report.codeUrl);link('Fullständig lista över automatiska testfall och resultat',report.testListUrl);
if (report.browser?.logUrl) link('Protokoll från webbläsartester',report.browser.logUrl);link('Sökbar systemdokumentation',report.wikiUrl);
text(`Kommandon:\n${report.commands.join('\n')}`,{size:9,fill:color.ink,gap:14});
text(`Testloggens SHA-256: ${report.tests.logSha256}`,{size:8.5,fill:color.muted});
text('Rapporten har inga undertecknade granskningsgodkännanden. En extern bedömning bör dokumentera vilka företagstyper, affärsfall och räkenskapsår som har granskats samt kvarstående avvikelser.',{size:9,fill:color.muted});

const pages=pdf.bufferedPageRange();
for(let i=0;i<pages.count;i++){
  pdf.switchToPage(i);pdf.moveTo(left,779).lineTo(left+width,779).strokeColor(color.line).stroke();
  pdf.font(regular).fontSize(8).fillColor(color.muted).text(`Fiktiv demo · tekniskt granskningsunderlag · ${report.revision.slice(0,7)}`,left,788,{width:400,lineBreak:false});
  pdf.text(`${i+1} / ${pages.count}`,left+430,788,{width:77,align:'right',lineBreak:false});
}
pdf.end();
await new Promise((resolve,reject)=>{stream.on('finish',resolve);stream.on('error',reject);});
console.log(JSON.stringify({output,pages:pages.count}));
