import { App } from './App';
import { DemoProvider } from './store';
import { EmployeeProvider } from './employee/EmployeeProvider';
import { EmployeeFleetProvider } from './employee/EmployeeFleet';

/** Keep mobile authentication, recovery data and pages out of the other portals. */
export default function MobileAppEntry() {
  return <EmployeeProvider><EmployeeFleetProvider><DemoProvider><App /></DemoProvider></EmployeeFleetProvider></EmployeeProvider>;
}
