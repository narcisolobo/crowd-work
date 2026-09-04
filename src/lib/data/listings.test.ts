import { describe, it, expect } from "vitest";
import { getNeighborhoods } from "./listings";

describe("getNeighborhoods", () => {
  it("returns neighborhoods ordered by name, each with its area id", async () => {
    const neighborhoods = await getNeighborhoods();

    const losFeliz = neighborhoods.find(
      (n) => n.id === "b0000000-0000-0000-0000-000000000001",
    );
    expect(losFeliz).toEqual({
      id: "b0000000-0000-0000-0000-000000000001",
      name: "Los Feliz",
      areaId: "a0000000-0000-0000-0000-000000000001",
    });

    const santaMonica = neighborhoods.find(
      (n) => n.id === "b0000000-0000-0000-0000-000000000003",
    );
    expect(santaMonica?.areaId).toBe("a0000000-0000-0000-0000-000000000002");

    const names = neighborhoods.map((n) => n.name);
    expect(names).toEqual([...names].sort());
  });
});
