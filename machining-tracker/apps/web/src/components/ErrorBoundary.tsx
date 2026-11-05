// Last-resort screen when a page fails to display: a plain message and a way back, never technical details
// (security acceptance test 15). Without it React would leave a blank white page.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // nothing is sent anywhere and no details are shown; the browser's developer console keeps React's own report
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">This page could not be displayed</h1>
          <p className="mt-2 text-sm text-slate-600">
            Your data is safe: nothing is saved halfway. Reload the page; if it happens again, go to the home page and tell the
            administrator what you were doing.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Reload page
            </button>
            <a href="/" className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Home page
            </a>
          </div>
        </div>
      </div>
    );
  }
}
