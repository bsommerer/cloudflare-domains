# Datei-Discovery. `_defaults.json` ist keine Site.
#
# `file()`/`fileset()` lösen relative Pfade gegen das Verzeichnis des Moduls
# auf – deshalb wird hier gegen `path.root` normalisiert, bevor der Pfad
# irgendwo weitergereicht wird.
locals {
  zone_page_size          = 1000
  worker_page_size        = 1000
  custom_domain_page_size = 1000

  sites_dir = var.sites_dir == null ? null : (
    startswith(var.sites_dir, "/") ? var.sites_dir : "${path.root}/${var.sites_dir}"
  )

  site_files = local.sites_dir == null ? [] : [
    for f in fileset(local.sites_dir, "*.json") : f if f != "_defaults.json"
  ]

  raw_sites = {
    for f in local.site_files :
    trimsuffix(f, ".json") => jsondecode(file("${local.sites_dir}/${f}"))
  }

  defaults = local.sites_dir == null ? {} : try(
    jsondecode(file("${local.sites_dir}/_defaults.json")), {}
  )

  # Die gesamte Rechenarbeit passiert im Planer-Modul – siehe tests/.
  sites                = module.plan.sites
  zone_id_for          = module.plan.zone_id_for
  zone_ids_by_name     = module.plan.zone_ids_by_name
  redirect_records     = module.plan.redirect_records
  rules_by_zone        = module.plan.rules_by_zone
  https_zones          = module.plan.https_zones
  findings             = module.plan.findings
  workers_dev_disabled = module.plan.workers_dev_disabled

  custom_domain_adoptions = module.plan.custom_domain_adoptions
}
