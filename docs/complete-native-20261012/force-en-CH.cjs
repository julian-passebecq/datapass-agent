const original=Number.prototype.toLocaleString; Number.prototype.toLocaleString=function(locales,options){return original.call(this,locales??'en-CH',options)};
