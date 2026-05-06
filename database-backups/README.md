# Oracle database backup

This folder contains a compressed Oracle legacy export for moving the DATY systems to another machine.

## Current backup

- `daty_oracle_systems_20260506-072303.zip`
- Schemas: `DATAALA`, `DATAALB`, `DATAALC`, `DATAALD`, `DATAALE`, `DATAALF`, `DATAALG`, `DATAALR`
- Units: `A`, `B`, `C`, `D`, `E`, `F`, `G`, `R`

## Restore

Extract the zip, then restore the dump with Oracle `imp.exe` using a DBA account.

```bat
imp USERID=system/your_password@your_db FILE=daty_oracle_systems.dmp FULL=Y LOG=daty_oracle_systems.imp.log
```

The archive does not include local `.env` secrets or Oracle installation files.
