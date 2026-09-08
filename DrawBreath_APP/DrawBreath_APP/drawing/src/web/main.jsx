import React from 'react'; import ReactDOM from 'react-dom/client'; import App from './App'; import './styles.css';
class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('[drawing-ui] rendering failed:', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="fatal-page"><section><h1>{document.title || 'The application'} could not display this page.</h1><p>Reload the application. Your saved drawing remains on the server.</p><button type="button" onClick={() => window.location.reload()}>Reload</button></section></main>;
  }
}
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>);
