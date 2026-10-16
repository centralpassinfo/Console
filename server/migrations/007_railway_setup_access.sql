-- Railway workspace setup tokens were once kept here. A workspace token can
-- manage every project in the workspace, so Console no longer stores one:
-- connecting a venue asks for it, uses it, and forgets it.
DROP TABLE IF EXISTS console_railway_setup_access;
