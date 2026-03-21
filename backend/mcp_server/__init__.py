"""MCP server package for LTX Desktop.

Exposes create_mcp_server() which returns a configured FastMCP instance
ready to be mounted onto the existing FastAPI app at /mcp.
"""

from mcp_server.server import create_mcp_server

__all__ = ["create_mcp_server"]
