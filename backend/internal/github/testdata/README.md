# GitHub API Test Data

This directory contains real GitHub GraphQL API responses used for unit testing the `github` package.

## Files

- `query.graphql`: The GraphQL query used to fetch the data for TestFetchInventory_Unit (Legacy format).
- `response.json`: The raw JSON response returned by the GitHub API for TestFetchInventory_Unit.
- `search_query.graphql`: The modern GraphQL search query used by fetchAllItems and FetchInventory/FetchRepoUpdates.
- `search_response.json`: A real response containing 1 PR and 1 Issue from kubernetes/kubernetes.
- `items_query.graphql`: The GraphQL query used for batch node hydration (FetchItems/FetchItemsByIDs).
- `items_response.json`: Real response for batch node hydration containing viewerSubscription and AssignedEvent.
- `resolve_node_ids_response.json`: Fixture representing aliased GraphQL responses for ResolveNodeIDs.
- `notifications_response.json`: A real response containing GitHub notification threads (PRs, Issues, Releases, CheckSuites).

## Regeneration

To regenerate the `notifications_response.json` file:
```bash
gh api /notifications -H "Accept: application/vnd.github+json" -F all=true > notifications_response.json
```

To regenerate the `response.json` file:
```bash
gh api graphql -F query=@query.graphql > response.json
```

To regenerate the `search_response.json` file:
```bash
# Fetch 1 PR
gh api graphql -F query=@search_query.graphql -f searchQuery='is:open repo:kubernetes/kubernetes is:pr sort:updated-desc' -F first=1 > pr.json
# Fetch 1 Issue
gh api graphql -F query=@search_query.graphql -f searchQuery='is:open repo:kubernetes/kubernetes is:issue sort:updated-desc' -F first=1 > issue.json
# Merge
jq -n --slurpfile pr pr.json --slurpfile issue issue.json '($pr[0].data.search.nodes + $issue[0].data.search.nodes) as $nodes | {data: {search: {nodes: $nodes, pageInfo: $pr[0].data.search.pageInfo}}}' > search_response.json
# Cleanup
rm pr.json issue.json
```

Note: This requires the [GitHub CLI](https://cli.github.com/) to be installed and authenticated.
