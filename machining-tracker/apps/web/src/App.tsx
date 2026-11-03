import { Suspense, lazy, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { PermissionKey } from "@cess/shared";
import { useAuth } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { Alert, Button, Spinner } from "./components/ui";
import { AuthShell } from "./pages/auth/AuthShell";
import { LoginPage } from "./pages/auth/LoginPage";
import { ForgotPasswordPage } from "./pages/auth/ForgotPasswordPage";
import { AuthConfirmPage } from "./pages/auth/AuthConfirmPage";
import { SetPasswordPage } from "./pages/auth/SetPasswordPage";
import { MfaPage } from "./pages/auth/MfaPage";
import { HomePage } from "./pages/HomePage";
import { AccountPage } from "./pages/AccountPage";
// Admin pages are loaded on demand so ordinary users download less.
const UsersPage = lazy(() => import("./pages/admin/UsersPage").then((m) => ({ default: m.UsersPage })));
const PermissionsPage = lazy(() => import("./pages/admin/PermissionsPage").then((m) => ({ default: m.PermissionsPage })));
const SettingsPage = lazy(() => import("./pages/admin/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const ActivityPage = lazy(() => import("./pages/admin/ActivityPage").then((m) => ({ default: m.ActivityPage })));
const SystemHealthPage = lazy(() => import("./pages/admin/SystemHealthPage").then((m) => ({ default: m.SystemHealthPage })));
const JobsRegisterPage = lazy(() => import("./pages/jobs/JobsRegisterPage").then((m) => ({ default: m.JobsRegisterPage })));
const NewJobPage = lazy(() => import("./pages/jobs/NewJobPage").then((m) => ({ default: m.NewJobPage })));
const JobDetailPage = lazy(() => import("./pages/jobs/JobDetailPage").then((m) => ({ default: m.JobDetailPage })));
const MissingDataPage = lazy(() => import("./pages/jobs/MissingDataPage").then((m) => ({ default: m.MissingDataPage })));
const VendorsPage = lazy(() => import("./pages/vendors/VendorsPage").then((m) => ({ default: m.VendorsPage })));
const VendorDetailPage = lazy(() => import("./pages/vendors/VendorDetailPage").then((m) => ({ default: m.VendorDetailPage })));
const ReliabilityPage = lazy(() => import("./pages/vendors/ReliabilityPage").then((m) => ({ default: m.ReliabilityPage })));
const QuotesPage = lazy(() => import("./pages/quotes/QuotesPage").then((m) => ({ default: m.QuotesPage })));
const QuoteDetailPage = lazy(() => import("./pages/quotes/QuoteDetailPage").then((m) => ({ default: m.QuoteDetailPage })));
const PriceHistoryPage = lazy(() => import("./pages/quotes/PriceHistoryPage").then((m) => ({ default: m.PriceHistoryPage })));
const PaymentsPage = lazy(() => import("./pages/payments/PaymentsPage").then((m) => ({ default: m.PaymentsPage })));
const NotificationsPage = lazy(() => import("./pages/notifications/NotificationsPage").then((m) => ({ default: m.NotificationsPage })));
const WhatsAppPage = lazy(() => import("./pages/whatsapp/WhatsAppPage").then((m) => ({ default: m.WhatsAppPage })));
const ReportsPage = lazy(() => import("./pages/reports/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const QualityPage = lazy(() => import("./pages/quality/QualityPage").then((m) => ({ default: m.QualityPage })));
const ImportExportPage = lazy(() => import("./pages/data/ImportExportPage").then((m) => ({ default: m.ImportExportPage })));

function RequireSession({ children }: { children: ReactNode }) {
  const { session, sessionLoading } = useAuth();
  const location = useLocation();
  if (sessionLoading) return <Spinner />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireAccess({ children }: { children: ReactNode }) {
  const { session, sessionLoading, access, accessLoading, accessError, signOut, refreshAccess } = useAuth();
  const location = useLocation();
  if (sessionLoading) return <FullPageSpinner />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (accessLoading || !access) {
    if (accessError) {
      return (
        <AuthShell title="Cannot load your account">
          <Alert tone="error">{accessError.message}</Alert>
          <div className="flex gap-2">
            <Button onClick={() => void refreshAccess()}>Try again</Button>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </AuthShell>
      );
    }
    return <FullPageSpinner />;
  }
  switch (access.status) {
    case "ok":
      return <>{children}</>;
    case "mfa_required":
      return <Navigate to="/mfa" replace />;
    case "session_expired":
      return <FullPageSpinner />;
    default:
      return (
        <AuthShell title="Account not active">
          <Alert tone="warning">
            {access.status === "inactive"
              ? "Your account is deactivated or not yet activated. Contact your Admin."
              : "Your account has no profile. Contact your Admin."}
          </Alert>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </AuthShell>
      );
  }
}

function RequirePermission({ anyOf, children }: { anyOf: PermissionKey[]; children: ReactNode }) {
  const { can } = useAuth();
  if (!anyOf.some((p) => can(p))) {
    return <Alert tone="warning" title="No access">You do not have permission to open this page. Ask your Admin if you need it.</Alert>;
  }
  return <Suspense fallback={<Spinner />}>{children}</Suspense>;
}

function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner />
    </div>
  );
}

export function App() {
  const { configError } = useAuth();
  if (configError) {
    return (
      <AuthShell title="Configuration needed">
        <Alert tone="error">{configError}</Alert>
      </AuthShell>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/auth/confirm" element={<AuthConfirmPage />} />
      <Route path="/set-password" element={<RequireSession><SetPasswordPage /></RequireSession>} />
      <Route path="/mfa" element={<RequireSession><MfaPage /></RequireSession>} />
      <Route element={<RequireAccess><Layout /></RequireAccess>}>
        <Route index element={<HomePage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="admin/users" element={<RequirePermission anyOf={["users.manage"]}><UsersPage /></RequirePermission>} />
        <Route path="admin/permissions" element={<RequirePermission anyOf={["users.manage"]}><PermissionsPage /></RequirePermission>} />
        <Route path="settings" element={<RequirePermission anyOf={["settings.change", "users.manage"]}><SettingsPage /></RequirePermission>} />
        <Route path="activity" element={<RequirePermission anyOf={["activity.view"]}><ActivityPage /></RequirePermission>} />
        <Route path="system" element={<RequirePermission anyOf={["system.view"]}><SystemHealthPage /></RequirePermission>} />
        <Route path="jobs" element={<RequirePermission anyOf={["jobs.view_all", "jobs.view_assigned"]}><JobsRegisterPage /></RequirePermission>} />
        <Route path="jobs/new" element={<RequirePermission anyOf={["jobs.create"]}><NewJobPage /></RequirePermission>} />
        <Route path="jobs/review" element={<RequirePermission anyOf={["jobs.view_all", "jobs.view_assigned"]}><MissingDataPage /></RequirePermission>} />
        <Route path="jobs/:id" element={<RequirePermission anyOf={["jobs.view_all", "jobs.view_assigned"]}><JobDetailPage /></RequirePermission>} />
        <Route path="vendors" element={<RequirePermission anyOf={["vendors.view"]}><VendorsPage /></RequirePermission>} />
        <Route path="vendors/reliability" element={<RequirePermission anyOf={["reliability.view"]}><ReliabilityPage /></RequirePermission>} />
        <Route path="vendors/:id" element={<RequirePermission anyOf={["vendors.view"]}><VendorDetailPage /></RequirePermission>} />
        <Route path="quotes" element={<RequirePermission anyOf={["costcompare.view"]}><QuotesPage /></RequirePermission>} />
        <Route path="quotes/history" element={<RequirePermission anyOf={["costcompare.view"]}><PriceHistoryPage /></RequirePermission>} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="reports" element={<RequirePermission anyOf={["reports.view"]}><ReportsPage /></RequirePermission>} />
        <Route path="quality" element={<RequirePermission anyOf={["quality.manage", "returns.record", "reports.view"]}><QualityPage /></RequirePermission>} />
        <Route path="whatsapp" element={<RequirePermission anyOf={["whatsapp.send"]}><WhatsAppPage /></RequirePermission>} />
        <Route path="payments" element={<RequirePermission anyOf={["payments.view"]}><PaymentsPage /></RequirePermission>} />
        <Route path="quotes/:id" element={<RequirePermission anyOf={["costcompare.view"]}><QuoteDetailPage /></RequirePermission>} />
        <Route path="data" element={<RequirePermission anyOf={["data.import", "reports.export"]}><ImportExportPage /></RequirePermission>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
