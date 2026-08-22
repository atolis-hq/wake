import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useState } from 'react';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import {
  Button,
  EmptyState,
  ErrorState,
  JsonViewer,
  LoadingState,
  PageHeader,
  Panel,
} from '../../components/primitives.js';
import styles from '../features.module.css';
import {
  mockConfiguredWorkflowDiagrams,
  mockWorkItemWorkflowDiagram,
} from '../workflow-diagram/model.js';
import { WorkflowDiagramView } from '../workflow-diagram/workflow-diagram.js';

export function ConfigurationPage() {
  const client = useApiClient();
  const [tab, setTab] = useState<'configuration' | 'commands' | 'workflows'>('configuration');
  const configurationQuery = useQuery({
    queryKey: queryKeys.system.configuration,
    queryFn: ({ signal }) => client.system.configuration(signal),
    refetchInterval: refreshPolicy.configuration,
  });
  const commandsQuery = useQuery({
    queryKey: queryKeys.system.commands,
    queryFn: ({ signal }) => client.system.commands(signal),
    refetchInterval: refreshPolicy.commands,
    enabled: tab === 'commands',
  });
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabs = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0) return;
    const nextIndex =
      event.key === 'ArrowRight'
        ? (currentIndex + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (currentIndex - 1 + tabs.length) % tabs.length
          : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (nextTab === undefined) return;
    setTab(nextTab.dataset.tab as typeof tab);
    nextTab.focus();
  };
  return (
    <>
      <PageHeader
        actions={
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              void (tab === 'commands' ? commandsQuery.refetch() : configurationQuery.refetch())
            }
          >
            Refresh {tab === 'commands' ? 'commands' : 'configuration'}
          </Button>
        }
      />
      <div className={styles.tabs} role="tablist" aria-label="Configuration sections">
        <button
          type="button"
          role="tab"
          data-tab="configuration"
          id="configuration-tab"
          aria-controls="configuration-panel"
          aria-selected={tab === 'configuration'}
          tabIndex={tab === 'configuration' ? 0 : -1}
          onKeyDown={navigateTabs}
          onClick={() => setTab('configuration')}
        >
          Configuration
        </button>
        <button
          type="button"
          role="tab"
          data-tab="commands"
          id="commands-tab"
          aria-controls="commands-panel"
          aria-selected={tab === 'commands'}
          tabIndex={tab === 'commands' ? 0 : -1}
          onKeyDown={navigateTabs}
          onClick={() => setTab('commands')}
        >
          Commands
        </button>
        <button
          type="button"
          role="tab"
          data-tab="workflows"
          id="workflows-tab"
          aria-controls="workflows-panel"
          aria-selected={tab === 'workflows'}
          tabIndex={tab === 'workflows' ? 0 : -1}
          onKeyDown={navigateTabs}
          onClick={() => setTab('workflows')}
        >
          Workflows
        </button>
      </div>
      {tab === 'commands' ? (
        <section id="commands-panel" role="tabpanel" aria-labelledby="commands-tab">
          {commandsQuery.isPending ? (
            <LoadingState label="Loading commands" />
          ) : commandsQuery.error && !commandsQuery.data ? (
            <ErrorState error={commandsQuery.error} retry={() => void commandsQuery.refetch()} />
          ) : (
            commandsQuery.data && (
              <>
                <p>Commands and actions recognized by each configured surface adapter.</p>
                {commandsQuery.data.data.adapters.length === 0 ? (
                  <EmptyState>No adapters expose commands</EmptyState>
                ) : (
                  commandsQuery.data.data.adapters.map((adapter) => (
                    <Panel key={adapter.adapter}>
                      <h2>{adapter.adapter}</h2>
                      {adapter.commands.length === 0 ? (
                        <EmptyState>No commands</EmptyState>
                      ) : (
                        <ul>
                          {adapter.commands.map((command) => (
                            <li key={command.syntax}>
                              <code>{command.syntax}</code>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Panel>
                  ))
                )}
              </>
            )
          )}
        </section>
      ) : tab === 'workflows' ? (
        <section id="workflows-panel" role="tabpanel" aria-labelledby="workflows-tab">
          <section aria-labelledby="configuration-workflow-definition">
            <h2 id="configuration-workflow-definition">Configuration workflow definition</h2>
            <WorkflowDiagramView diagram={mockConfiguredWorkflowDiagrams[0]!} />
          </section>
          <section aria-labelledby="work-item-workflow-instance">
            <h2 id="work-item-workflow-instance">Work-item workflow instance</h2>
            <WorkflowDiagramView diagram={mockWorkItemWorkflowDiagram} />
          </section>
        </section>
      ) : (
        <section id="configuration-panel" role="tabpanel" aria-labelledby="configuration-tab">
          {configurationQuery.isPending ? (
            <LoadingState label="Loading redacted configuration" />
          ) : configurationQuery.error && !configurationQuery.data ? (
            <ErrorState
              error={configurationQuery.error}
              retry={() => void configurationQuery.refetch()}
            />
          ) : (
            configurationQuery.data && (
              <Panel>
                <p>Read-only effective configuration. Secrets are redacted by Wake.</p>
                <JsonViewer value={configurationQuery.data.data.configuration} />
              </Panel>
            )
          )}
        </section>
      )}
    </>
  );
}
