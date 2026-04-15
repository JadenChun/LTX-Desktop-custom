from __future__ import annotations


def test_backend_no_longer_exposes_mcp_routes(client) -> None:
    response = client.get("/mcp")
    assert response.status_code == 404

    response = client.get("/mcp-sse")
    assert response.status_code == 404
