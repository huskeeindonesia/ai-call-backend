import fs from 'node:fs';
import path from 'node:path';

function readData() {
  const p = path.join(process.cwd(), 'data', 'dashboard.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function Card({ title, value, sub }) {
  return (
    <div style={{ background: '#121933', border: '1px solid #24305e', borderRadius: 14, padding: 16 }}>
      <div style={{ opacity: 0.75, fontSize: 13 }}>{title}</div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6 }}>{value}</div>
      {sub ? <div style={{ opacity: 0.7, marginTop: 6, fontSize: 13 }}>{sub}</div> : null}
    </div>
  );
}

export default function Page() {
  const d = readData();
  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <h1 style={{ margin: 0 }}>Huskee Management Dashboard</h1>
      <p style={{ opacity: 0.75 }}>Updated: {new Date(d.updatedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12 }}>
        <Card title="Token Usage Today" value={d.tokenUsage.today.toLocaleString('id-ID')} sub={`Budget ${d.tokenUsage.budget.toLocaleString('id-ID')}`} />
        <Card title="Avg Token/Hour" value={d.tokenUsage.avgPerHour.toLocaleString('id-ID')} />
        <Card title="Context Avg" value={d.context.avgLength.toLocaleString('id-ID')} sub={`Limit ${d.context.limit.toLocaleString('id-ID')}`} />
        <Card title="Comms 24h" value={d.comms.messages24h} sub={`Handoffs ${d.comms.handoffs} • Blockers ${d.comms.blockers}`} />
      </div>

      <h2 style={{ marginTop: 24 }}>Agent Workload</h2>
      <div style={{ background: '#121933', border: '1px solid #24305e', borderRadius: 14, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={{ textAlign:'left', padding:12 }}>Agent</th><th style={{ textAlign:'left', padding:12 }}>Role</th><th style={{ textAlign:'left', padding:12 }}>Status</th><th style={{ textAlign:'left', padding:12 }}>Load</th><th style={{ textAlign:'left', padding:12 }}>Open Tasks</th></tr></thead>
          <tbody>
            {d.agents.map((a) => (
              <tr key={a.name} style={{ borderTop: '1px solid #24305e' }}>
                <td style={{ padding: 12 }}>{a.name}</td>
                <td style={{ padding: 12 }}>{a.role}</td>
                <td style={{ padding: 12 }}>{a.status}</td>
                <td style={{ padding: 12 }}>{a.load}%</td>
                <td style={{ padding: 12 }}>{a.tasksOpen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 24 }}>Schedule</h2>
      <ul>
        {d.schedule.map((s, i) => <li key={i}>{s.time} — {s.event} ({s.owner})</li>)}
      </ul>
    </main>
  );
}
