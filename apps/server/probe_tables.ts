import { pool } from './src/db/pool';
async function main(){
  const {rows}=await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  console.log(rows.map(r=>r.table_name).join('\n'));
  await pool.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
