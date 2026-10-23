import PDFDocument from 'pdfkit';
import { readFileSync, createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error('Usage: node scripts/build-bokforing-remediation-pdf.mjs report.json report.pdf');
const report = JSON.parse(readFileSync(source, 'utf8'));
if (!(report.tests.totalPassed > 0 && report.tests.failed === 0 && report.browser.passed > 0)) throw new Error('Final passed test evidence is required before publication.');
mkdirSync(dirname(target), { recursive: true });
const pdf = new PDFDocument({ size:'A4', margin:44, bufferPages:true, info:{ Title:'ScrapPlanner – åtgärder efter teknisk regelgranskning', Author:'ScrapPlanner', Subject:`Testad bokföringskod ${report.revision}` } });
const output=createWriteStream(target);pdf.pipe(output);
const fonts='/usr/share/fonts/opentype/urw-base35';
const regular=existsSync(`${fonts}/NimbusSans-Regular.otf`)?'ReportRegular':'Helvetica';
const bold=regular==='ReportRegular'?'ReportBold':'Helvetica-Bold';
if(regular==='ReportRegular'){pdf.registerFont(regular,`${fonts}/NimbusSans-Regular.otf`);pdf.registerFont(bold,`${fonts}/NimbusSans-Bold.otf`);}
const ink='#142B45',muted='#546579',blue='#245CC5',width=507,left=44;let y=48;
function line(text,{size=10.5,strong=false,color=ink,gap=8}={}){
 pdf.font(strong?bold:regular).fontSize(size);
 const height=pdf.heightOfString(text,{width,lineGap:2});
 if(y+height>754)throw new Error('Report exceeds the reviewed two-page layout.');
 pdf.fillColor(color).text(text,left,y,{width,lineGap:2});y+=height+gap;
}
function heading(text){line(text,{size:14,strong:true,gap:9});}
function url(label,address){line(label,{size:9.5,strong:true,gap:3});pdf.font(regular).fontSize(8.3);const h=pdf.heightOfString(address,{width});pdf.fillColor(blue).text(address,left,y,{width,link:address});y+=h+10;}
line('SCRAPPLANNER / BOKFÖRING',{size:10,strong:true,color:blue,gap:20});
line('Åtgärder efter regelgranskningen',{size:23,strong:true,gap:14});
line(`${report.date} · Testad bokföringskod ${report.revision}`,{size:9,color:muted,gap:18});
line(`${report.tests.totalPassed.toLocaleString('sv-SE')} automatiska tester godkända · ${report.browser.passed} webbläsarfall godkända`,{size:14,strong:true,gap:6});
line(`${report.tests.newPassed} tillkommande fall för åtgärderna. Slutkörningen har inga underkända eller överhoppade automatiska tester.`,{size:10,color:muted,gap:19});
for(const action of report.actions){heading(action.title);line(action.text,{size:10.5,gap:14});}
heading('Bedömning');line(report.conclusion,{size:10.5,strong:true,gap:12});
url('Prova den publicerade demon',report.demoUrl);

pdf.addPage();y=48;
line('GRANSKNINGSUNDERLAG',{size:10,strong:true,color:blue,gap:18});
line('Testbevis och kvarstående arbete',{size:22,strong:true,gap:15});
heading('Vad som har kontrollerats');
line(report.method,{size:10,gap:12});
line(report.browser.summary,{size:10,gap:14});
heading('Vad som återstår');
for(const gap of report.gaps)line(`• ${gap}`,{size:10,gap:7});
heading('Förslag till extern granskning');
for(const check of report.review)line(`• ${check}`,{size:10,gap:6});
heading('Källor och spårbarhet');
line(report.sources.join('\n'),{size:8.5,color:muted,gap:10});
url('Kod, testfall och ändringar',`https://github.com/NicklasJr93/JEROC-Atervinning/commit/${report.revision}`);
url('Testförteckning och protokoll',report.evidenceUrl);
line('Den första rapportens historiska resultat och fynd finns kvar separat. Denna uppföljning avser ovan angiven bokföringskod; dokumentation och rapport publiceras därefter. Inget myndighetsgodkännande eller oberoende revisionsintyg lämnas.',{size:8.5,color:muted,gap:0});
const pages=pdf.bufferedPageRange();
for(let i=0;i<pages.count;i++){pdf.switchToPage(i);pdf.page.margins.bottom=0;pdf.moveTo(44,779).lineTo(551,779).strokeColor('#D9E1E9').stroke();pdf.font(regular).fontSize(8).fillColor(muted).text(`Fiktiv demo · ${report.revision.slice(0,7)} · ${i+1}/${pages.count}`,44,789,{width,lineBreak:false});}
pdf.end();await new Promise((resolve,reject)=>{output.on('finish',resolve);output.on('error',reject);});
console.log(JSON.stringify({target,pages:pages.count}));
