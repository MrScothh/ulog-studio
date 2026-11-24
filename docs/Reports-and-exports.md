# Reports and exports

## HTML report

**Report** (top right) builds a single self-contained HTML file with every page of the current log: tables, checks and every chart as an image. It opens in any browser without ULog Studio, and *Print → Save as PDF* turns it into a PDF. The map is not embedded (no basemap tiles leave the app).

## Charts

Each chart's corner buttons: enlarge, save as **PNG**, export the plotted data as **CSV**. Tables have a **CSV** link.

## Proposed values

The [Gyro filters](Gyro-filters.md) and [Rate loop](Rate-loop.md) pages export the values you changed as a QGroundControl `.params` file (*Export changed*). Load it in QGroundControl (*Parameters › Tools › Load from file*) after reviewing it. ULog Studio never connects to a vehicle and never writes parameters.
