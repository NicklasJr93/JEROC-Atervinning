import { App } from './App';
import { DemoProvider } from './store';
import { EmployeeProvider } from './employee/EmployeeProvider';

/** Keep mobile authentication, recovery data and pages out of the other portals. */
export default function MobileAppEntry() {
  return <EmployeeProvider><DemoProvider><App /></DemoProvider></EmployeeProvider>;
}
