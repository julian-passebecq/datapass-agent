export const meta = {
  name: 'demo-run',
  description: 'Demo workflow with a } brace in a string',
  phases: [{ title: 'Code', detail: 'one coder per package' }, { title: 'Verify' }, { title: 'Ship', detail: "it's done" }],
}
phase('Code')
const r = await agent(`do it`, { label: 'code:ONE', phase: 'Code' })
