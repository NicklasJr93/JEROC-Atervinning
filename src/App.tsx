import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useDemo } from './store';
import { Notice, Nav } from './components';
import { useEmployee } from './employee/EmployeeProvider';
import {
  EmployeeLoginPage, EmployeeHomePage, EmployeeSchedulePage, EmployeeTimePage,
  EmployeeProfilePage, EmployeeAssignmentsPage, EmployeeRequirementPage, EmployeeTimeGate,
} from './employee/EmployeePages';
import {
  HomePage,
  DraftsPage,
  PasswordPage,
} from './pages/Overview';
import {
  ModePage,
  MaterialsPage,
  ArticlePage,
  WeightPage,
  SummaryPage,
  DonePage,
} from './pages/Weighing';
import { PricesPage, ArticlePricesPage } from './pages/Prices';
import { VehiclePage } from './pages/Vehicle';
import { CustomerPage, NewCustomerPage, ReferencePage } from './pages/Customer';

export function App() {
  const { loggedIn, storageError, data, sharedReady } = useDemo();
  const employee = useEmployee();
  const location = useLocation();
  const draftId = location.pathname.match(/^\/weigh\/([^/]+)/)?.[1];
  const locked = data.drafts.find((d) => d.id === draftId)?.status === 'ready';
  const fixed =
    !loggedIn ||
    ['/yard', '/password', '/drafts'].includes(location.pathname) ||
    location.pathname.includes('/weight/') ||
    location.pathname.startsWith('/prices');
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  const yardRoute = ['/yard', '/drafts', '/prices', '/new', '/weigh'].some(path => location.pathname.startsWith(path));
  const yardPage = (page: React.ReactNode) => !employee.session?.capabilities.yardWork
    ? <Navigate to="/" replace />
    : employee.overview?.gate.blocked
      ? <Navigate to={`/time?date=${employee.overview.gate.date ?? employee.overview.today}&register=1`} replace />
      : !sharedReady
        ? <><main className="employee-page" role="status"><h1>Gårdsarbete</h1><p>Hämtar aktuella vägningar…</p></main><Nav /></>
        : page;
  return (
    <div className={`app-shell employee-app ${fixed ? 'fixed-screen' : ''}`}>
      {storageError && yardRoute && loggedIn && (
        <div className="storage-error">
          <Notice tone="red">{storageError}</Notice>
        </div>
      )}
      {employee.loading ? (
        <main className="employee-page" role="status"><p>Öppnar appen…</p></main>
      ) : !loggedIn ? (
        <EmployeeLoginPage />
      ) : locked && !/\/(summary|done)$/.test(location.pathname) ? (
        <Navigate to={`/weigh/${draftId}/summary`} replace />
      ) : (
        <Routes>
          <Route path="/" element={<EmployeeHomePage />} />
          <Route path="/yard" element={yardPage(<HomePage />)} />
          <Route path="/schedule" element={<EmployeeSchedulePage />} />
          <Route path="/time" element={<EmployeeTimePage />} />
          <Route path="/assignments" element={<EmployeeAssignmentsPage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/drafts" element={yardPage(<DraftsPage />)} />
          <Route path="/prices" element={yardPage(<PricesPage />)} />
          <Route path="/prices/:articleId" element={yardPage(<ArticlePricesPage />)} />
          <Route path="/profile" element={<EmployeeProfilePage />} />
          <Route path="/profile/contact" element={<EmployeeProfilePage />} />
          <Route path="/profile/password" element={<EmployeeProfilePage />} />
          <Route path="/profile/requirements" element={<EmployeeRequirementPage />} />
          <Route path="/profile/accounts" element={<EmployeeProfilePage />} />
          <Route path="/password" element={<PasswordPage />} />
          <Route path="/new" element={yardPage(<ModePage />)} />
          <Route path="/pending" element={<Navigate to="/yard" replace />} />
          <Route path="/weigh/:draftId/materials" element={yardPage(<MaterialsPage />)} />
          <Route
            path="/weigh/:draftId/materials/:categoryId"
            element={yardPage(<MaterialsPage />)}
          />
          <Route
            path="/weigh/:draftId/article/:articleId"
            element={yardPage(<ArticlePage />)}
          />
          <Route
            path="/weigh/:draftId/weight/:articleId"
            element={yardPage(<WeightPage />)}
          />
          <Route path="/weigh/:draftId/vehicle" element={yardPage(<VehiclePage />)} />
          <Route path="/weigh/:draftId/summary" element={yardPage(<SummaryPage />)} />
          <Route path="/weigh/:draftId/customer" element={yardPage(<CustomerPage />)} />
          <Route
            path="/weigh/:draftId/customer/new"
            element={yardPage(<NewCustomerPage />)}
          />
          <Route path="/weigh/:draftId/reference" element={yardPage(<ReferencePage />)} />
          <Route path="/weigh/:draftId/done" element={yardPage(<DonePage />)} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
      {loggedIn && !employee.loading && <EmployeeTimeGate />}
    </div>
  );
}
