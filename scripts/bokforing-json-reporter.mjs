// Machine-readable evidence from node:test; one record per completed test.
export default async function* report(source) {
  for await (const event of source) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    const item=event.data;
    yield JSON.stringify({name:item.name,file:item.file,line:item.line,column:item.column,nesting:item.nesting,
      status:event.type==='test:pass'?'passed':'failed',durationMs:item.details?.duration_ms,
      skip:Boolean(item.skip),todo:Boolean(item.todo),error:item.details?.error?.message??null})+'\n';
  }
}
