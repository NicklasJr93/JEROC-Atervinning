import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useDemo } from './store';
import { Notice } from './components';
import {
  Login,
  HomePage,
  DraftsPage,
  PricesPage,
  ProfilePage,
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
import { VehiclePage, PendingPage } from './pages/Vehicle';
import { CustomerPage, NewCustomerPage, ReferencePage } from './pages/Customer';

export function App() {
  const { loggedIn, storageError } = useDemo();
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return (
    <div className="app-shell">
      <div className="demo-strip">
        <span className="status-dot" /> Demo · Inget skickas till kontoret
      </div>
      {storageError && (
        <div className="storage-error">
          <Notice tone="red">{storageError}</Notice>
        </div>
      )}
      {!loggedIn ? (
        <Login />
      ) : (
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/drafts" element={<DraftsPage />} />
          <Route path="/prices" element={<PricesPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/password" element={<PasswordPage />} />
          <Route path="/new" element={<ModePage />} />
          <Route path="/pending" element={<PendingPage />} />
          <Route path="/weigh/:draftId/materials" element={<MaterialsPage />} />
          <Route
            path="/weigh/:draftId/materials/:categoryId"
            element={<MaterialsPage />}
          />
          <Route
            path="/weigh/:draftId/article/:articleId"
            element={<ArticlePage />}
          />
          <Route
            path="/weigh/:draftId/weight/:articleId"
            element={<WeightPage />}
          />
          <Route path="/weigh/:draftId/vehicle" element={<VehiclePage />} />
          <Route path="/weigh/:draftId/summary" element={<SummaryPage />} />
          <Route path="/weigh/:draftId/customer" element={<CustomerPage />} />
          <Route
            path="/weigh/:draftId/customer/new"
            element={<NewCustomerPage />}
          />
          <Route path="/weigh/:draftId/reference" element={<ReferencePage />} />
          <Route path="/weigh/:draftId/done" element={<DonePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </div>
  );
}
