export async function checkAll() {
  const targets = loadTargets();
  const autoTargets = targets.filter(t => t.autoScan !== false); // Only autoScan=true or undefined
  
  console.log(`[scan] starting scheduled scan for ${autoTargets.length}/${targets.length} targets`);
  
  for (const target of autoTargets) {
    await scanTarget(target);
  }
}
