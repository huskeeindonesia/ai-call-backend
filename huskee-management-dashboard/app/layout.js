export const metadata = {
  title: 'Huskee Management Dashboard',
  description: 'Monitor agents, tasks, communication, and schedules'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'Inter, system-ui, sans-serif', background: '#0b1020', color: '#e8ecff' }}>
        {children}
      </body>
    </html>
  );
}
