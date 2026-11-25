"""Multi-client and multi-location ranking run orchestrator."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from src.browser.session import BrowserSession
from src.ranking.batch_checker import BatchKeywordChecker, BatchRunSummary, KeywordTask
from src.storage.sqlite_store import RankingStore
from src.utils.client_config import ClientConfig, ClientLocationConfig


@dataclass(frozen=True)
class LocationRunOutcome:
    """Outcome for a single (client, location) ranking run."""

    client_id: str
    client_name: str
    location_name: str
    summary: BatchRunSummary | None = None
    error: str | None = None


TaskProvider = Callable[[ClientConfig, ClientLocationConfig], list[KeywordTask]]


class MultiClientOrchestrator:
    """Execute ranking batches across multiple active clients and locations."""

    def __init__(
        self,
        batch_checker: BatchKeywordChecker | None = None,
        store: RankingStore | None = None,
        *,
        headless: bool = True,
    ) -> None:
        self.batch_checker = batch_checker or BatchKeywordChecker()
        self.store = store
        self.headless = headless

    def run_all(
        self,
        clients: list[ClientConfig],
        task_provider: TaskProvider,
    ) -> list[LocationRunOutcome]:
        """Run ranking checks for every active client and each of its configured locations."""
        active_clients = [c for c in clients if c.active]
        if not active_clients:
            return []

        outcomes: list[LocationRunOutcome] = []
        first_geo = active_clients[0].locations[0].to_geolocation()

        with BrowserSession(first_geo, headless=self.headless) as session:
            for client in active_clients:
                for loc in client.locations:
                    try:
                        session.set_location(loc.to_geolocation())
                        tasks = task_provider(client, loc)
                        summary = self.batch_checker.run_batch(
                            session,
                            tasks,
                            client.website_domain,
                            client_id=client.client_id,
                            max_depth=loc.search_depth,
                        )
                        if self.store is not None:
                            self.store.save_run(summary)
                        outcomes.append(
                            LocationRunOutcome(
                                client_id=client.client_id,
                                client_name=client.client_name,
                                location_name=loc.location_name,
                                summary=summary,
                            )
                        )
                    except Exception as exc:
                        outcomes.append(
                            LocationRunOutcome(
                                client_id=client.client_id,
                                client_name=client.client_name,
                                location_name=loc.location_name,
                                error=str(exc),
                            )
                        )
        return outcomes

