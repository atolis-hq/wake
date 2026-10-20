import type { DeliveryIntegrationResponse } from '../../../../api/contracts/work.js';

/** Integration progress and agent maintenance of a parent delivery, as Wake derived them. */
export function DeliveryIntegration({
  integration,
}: {
  readonly integration: DeliveryIntegrationResponse;
}) {
  return (
    <div>
      <h3>Integration</h3>
      <p>{integration.summary}</p>
      <ul>
        {integration.targets.map((target) => (
          <li key={`${target.workItemKey}/${target.outputName}`}>
            {target.workItemKey}/{target.outputName}: {target.state}
            {target.maintenance && ` (${target.maintenance})`}
            {target.evidenceAffected && ' - needs fresh review, checks and QA'}
          </li>
        ))}
      </ul>
      {integration.maintenance.length > 0 && (
        <ul>
          {integration.maintenance.map((item) => (
            <li key={item.maintenanceId}>
              Maintained {item.workItemKey}/{item.outputName} ({item.kind}): {item.previousRevision}{' '}
              to {item.currentRevision}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
